"""Fase 1: core headless pela linha de comandos.

Exemplos:
  python -m app.tools.rag_cli new                       # cria conversa, imprime o id
  python -m app.tools.rag_cli ingest aula3.pdf -c <id>  # indexa um ficheiro nessa conversa
  python -m app.tools.rag_cli ask "O que é overfitting?" -c <id>
  python -m app.tools.rag_cli search "overfitting" -c <id>   # só retrieval, mostra scores
  python -m app.tools.rag_cli list | delete -c <id> | cleanup
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from ..core.config import load_settings
from ..core.limits import InferenceQueue
from ..services import conversations as convs
from ..services import documents as docs
from ..services.factory import make_embedder, make_llm
from ..services.rag_engine import AnswerResult, RagEngine, cite_label
from ..services.workspace import Workspace


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="rag_cli")
    ap.add_argument("--profile", "-p", default="rui")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("new").add_argument("--title")
    sub.add_parser("list")
    sub.add_parser("cleanup")
    for name in ("ingest", "ask", "search", "delete", "docs", "history"):
        sp = sub.add_parser(name)
        sp.add_argument("--conversation", "-c", required=True)
        if name == "ingest":
            sp.add_argument("files", nargs="+", type=Path)
        if name in ("ask", "search"):
            sp.add_argument("query")
            sp.add_argument("--no-history", action="store_true")
    args = ap.parse_args(argv)

    s = load_settings()
    ws = Workspace(s, args.profile)

    if args.cmd == "new":
        print(convs.create(ws, args.title)["id"])
        return 0
    if args.cmd == "list":
        for c in convs.list_all(ws):
            pin = "📌" if c["pinned"] else "  "
            print(f"{pin} {c['id']}  {c['title']}  (última atividade {c['last_activity_at']})")
        return 0
    if args.cmd == "cleanup":
        print(json.dumps({"deleted": convs.cleanup_expired(ws), **convs.reconcile(ws)}, indent=2))
        return 0

    if convs.get(ws, args.conversation) is None:
        print("Conversa não encontrada neste perfil.", file=sys.stderr)
        return 2

    if args.cmd == "delete":
        convs.delete(ws, args.conversation)
        print("Apagada.")
        return 0
    if args.cmd == "docs":
        for d in docs.list_documents(ws, args.conversation):
            print(f"{d['id']}  {d['filename']}  ({d['n_chunks']} blocos)")
        return 0
    if args.cmd == "history":
        for m in convs.messages(ws, args.conversation):
            print(f"[{m['role']}] {m['content']}\n")
        return 0

    embedder = make_embedder(s)
    if args.cmd == "ingest":
        for f in args.files:
            try:
                summary = docs.ingest(ws, embedder, args.conversation, f.name, f.read_bytes())
            except docs.IngestError as e:
                print(f"{f.name}: ERRO {e.message}", file=sys.stderr)
                continue
            print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    engine = RagEngine(s, make_llm(s), embedder, InferenceQueue())
    if args.cmd == "search":
        hits = asyncio.run(engine.retrieve(ws, args.conversation, args.query))
        for h in hits:
            mark = "✓" if h["score"] >= s.score_threshold else "✗"
            print(f"{mark} {h['score']:.3f}  [{cite_label(h)}]  {h['chunk_text'][:150]}…")
        print(f"(threshold = {s.score_threshold})")
        return 0

    # ask
    history = [] if args.no_history else convs.recent_history(ws, args.conversation, s.history_turns)
    result = AnswerResult()

    async def run():
        async for ev in engine.answer(ws, args.conversation, args.query, history, result):
            if ev["type"] == "token":
                print(ev["data"], end="", flush=True)
            elif ev["type"] == "rewrite":
                print(f"(pergunta reescrita: {ev['data']})\n", file=sys.stderr)

    asyncio.run(run())
    print("\n")
    for src in result.sources:
        if src["score"] is not None:
            score = f"score {src['score']}"
        else:
            score = f"secção: {src['section_title']}" if src["section_title"] else "documento inteiro"
        print(f"  • [{cite_label(src)}] {score}")
    print(f"  tokens: prompt={result.usage.prompt_tokens} geração={result.usage.gen_tokens}"
          + ("  (recusa sem chamar o LLM)" if result.refused and not result.llm_called else ""))
    convs.save_exchange(ws, args.conversation, args.query, result.answer, result.sources,
                        result.usage.prompt_tokens, result.usage.gen_tokens)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
