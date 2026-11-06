"""Fase 0: avaliação da resolução de casos práticos com um conjunto de perguntas de teste.

Indexa o material numa pasta temporária (nunca toca nos dados dos perfis), retira do corpus as
perguntas de teste (`excluir_do_corpus` do conjunto) e mede, para cada pergunta:

- pesquisa (sem LLM, rápido): se os blocos recuperados cobrem os temas esperados e os artigos
  essenciais, e em que posição aparece o primeiro bloco do tema certo;
- resolução (`--solve`, usa o Ollama): corre o `CaseTools.solve` da app e compara os artigos e
  os temas da resposta com o gabarito.

Exemplos (na pasta backend, com o venv ativo):
  python -m app.tools.eval_cases ~/Documentos/aulas.docx ~/Documentos/respostas.docx
  python -m app.tools.eval_cases *.docx *.pdf --solve --out eval/resultado.json
  python -m app.tools.eval_cases *.docx --embedder hash        # sem descarregar o BGE-M3

Os números servem para comparar versões do sistema entre si (antes/depois de uma mudança),
não como nota absoluta: o gabarito é pequeno e as etiquetas de temas são heurísticas.
"""
from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import sys
import tempfile
from pathlib import Path

from ..core.config import Settings, load_settings
from ..core.limits import InferenceQueue
from ..services import conversations as convs
from ..services import documents as docs
from ..services.case_tools import CaseTools
from ..services.factory import make_embedder, make_llm
from ..services.legal_refs import article_bases, fold, tag_topics
from ..services.rag_engine import AnswerResult
from ..services.workspace import Workspace

DEFAULT_EVALSET = Path(__file__).resolve().parents[2] / "eval" / "casos_dt.json"
NOT_FOUND = "não encontrei nos documentos"


def _split(value: str | None) -> list[str]:
    return [v for v in (value or "").split("; ") if v]


def _bases(meta_articles: str | None) -> set[str]:
    return set(article_bases(meta_articles or ""))


def _recall(expected: list[str], found: set[str]) -> float | None:
    return round(len(set(expected) & found) / len(expected), 3) if expected else None


def _mean(values: list[float | None]) -> float | None:
    vals = [v for v in values if v is not None]
    return round(sum(vals) / len(vals), 3) if vals else None


def _excluded(meta: dict, text: str, rules: dict) -> bool:
    case_id = meta.get("caso_id") or ""
    for prefix in rules.get("caso_id", []):
        if case_id and (case_id == prefix or (prefix.endswith("/") and case_id.startswith(prefix))):
            return True
    folded = fold(text)
    return any(fold(t) in folded for t in rules.get("texto", []))


def _remove_held_out(ws: Workspace, conversation_id: str, rules: dict) -> int:
    col = ws.vectors.collection
    got = col.get(where={"conversation_id": conversation_id}, include=["metadatas", "documents"])
    ids = [i for i, m, d in zip(got["ids"], got["metadatas"], got["documents"]) if _excluded(m, d, rules)]
    if ids:
        col.delete(ids=ids)
    return len(ids)


def _retrieval_metrics(item: dict, hits: list[dict]) -> dict:
    expected_topics = item.get("temas_esperados", [])
    topics = set().union(*(_split(h.get("temas")) for h in hits)) if hits else set()
    articles = set().union(*(_bases(h.get("artigos")) for h in hits)) if hits else set()
    first = next((i for i, h in enumerate(hits, 1) if set(_split(h.get("temas"))) & set(expected_topics)), None)
    kinds: dict[str, int] = {}
    for h in hits:
        kinds[h.get("tipo") or "sem tipo"] = kinds.get(h.get("tipo") or "sem tipo", 0) + 1
    return {
        "temas_recall": _recall(expected_topics, topics),
        "artigos_recall": _recall(item.get("artigos_essenciais", []), articles),
        "primeiro_relevante": first,
        "tipos": kinds,
        "blocos": [
            {"fonte": h["source"], "local": h.get("section_title", ""), "tipo": h.get("tipo"),
             "score": round(h["score"], 3), "temas": h.get("temas", ""), "artigos": h.get("artigos", "")}
            for h in hits
        ],
    }


def _answer_metrics(item: dict, answer: str) -> dict:
    cited = article_bases(answer)
    essential = item.get("artigos_essenciais", [])
    accepted = set(essential) | set(item.get("artigos_aceites", []))
    return {
        "artigos_citados": cited,
        "artigos_recall": _recall(essential, set(cited)),
        "artigos_precisao": round(len([a for a in cited if a in accepted]) / len(cited), 3) if cited else None,
        "temas_recall": _recall(item.get("temas_esperados", []), set(tag_topics(answer))),
        "partes_sem_materia": fold(answer).count(fold(NOT_FOUND)),
        "palavras": len(answer.split()),
    }


async def run(
    evalset: dict, corpus: list[Path], settings: Settings, *, k: int | None = None, solve: bool = False,
    llm=None, embedder=None, log=print,
) -> dict:
    k = k or settings.top_k * 3          # o mesmo que o CaseTools.solve usa
    embedder = embedder or make_embedder(settings)
    with tempfile.TemporaryDirectory(prefix="dire-eval-") as tmp:
        s = dataclasses.replace(settings, data_dir=Path(tmp), max_files_per_conversation=max(50, len(corpus)))
        ws = Workspace(s, "eval")
        cid = convs.create(ws, "Avaliação")["id"]
        refs = []
        for path in corpus:
            r = docs.ingest(ws, embedder, cid, path.name, path.read_bytes())
            if not r.get("duplicate"):
                refs.append({"id": r["doc_id"], "filename": path.name})
                log(f"  indexado {path.name}: {r['n_chunks']} blocos")
        removed = _remove_held_out(ws, cid, evalset.get("excluir_do_corpus", {}))
        log(f"  retirados do corpus (perguntas de teste): {removed} blocos")

        tools = CaseTools(s, llm or make_llm(s), embedder, InferenceQueue()) if solve else None
        items = []
        for item in evalset["itens"]:
            case_text = "\n".join(p for p in (item.get("enunciado", ""), item["pergunta"]) if p).strip()
            emb = await asyncio.to_thread(embedder.embed_query, case_text[:4000])
            hits = ws.vectors.query(emb, ws.scopes(cid), k, [r["id"] for r in refs])
            row = {"id": item["id"], "pesquisa": _retrieval_metrics(item, hits)}
            if tools:
                log(f"  a resolver {item['id']}…")
                result = AnswerResult(query=case_text)
                async for _ in tools.solve(ws, cid, refs, case_text, None, result):
                    pass
                row["resolucao"] = {**_answer_metrics(item, result.answer), "resposta": result.answer}
            items.append(row)

    summary = {
        "pesquisa": {
            "temas_recall": _mean([r["pesquisa"]["temas_recall"] for r in items]),
            "artigos_recall": _mean([r["pesquisa"]["artigos_recall"] for r in items]),
        },
    }
    if solve:
        summary["resolucao"] = {
            key: _mean([r["resolucao"][key] for r in items])
            for key in ("artigos_recall", "artigos_precisao", "temas_recall")
        }
    return {"k": k, "blocos_retirados": removed, "resumo": summary, "itens": items,
            "corpus": [p.name for p in corpus], "modelo": settings.ollama_model if solve else None,
            "embeddings": settings.embeddings_backend}


def _fmt(v) -> str:
    return "–" if v is None else (f"{v:.2f}" if isinstance(v, float) else str(v))


def report_table(report: dict) -> str:
    solve = "resolucao" in report["resumo"]
    head = "| pergunta | temas@k | artigos@k | 1.º relevante |"
    sep = "|---|---|---|---|"
    if solve:
        head += " artigos (recall) | artigos (precisão) | temas | partes sem matéria |"
        sep += "---|---|---|---|"
    lines = [head, sep]
    for r in report["itens"]:
        p = r["pesquisa"]
        line = f"| {r['id']} | {_fmt(p['temas_recall'])} | {_fmt(p['artigos_recall'])} | {_fmt(p['primeiro_relevante'])} |"
        if solve:
            a = r["resolucao"]
            line += (f" {_fmt(a['artigos_recall'])} | {_fmt(a['artigos_precisao'])} | {_fmt(a['temas_recall'])}"
                     f" | {a['partes_sem_materia']} |")
        lines.append(line)
    s = report["resumo"]
    line = f"| **média** | {_fmt(s['pesquisa']['temas_recall'])} | {_fmt(s['pesquisa']['artigos_recall'])} | |"
    if solve:
        line += (f" {_fmt(s['resolucao']['artigos_recall'])} | {_fmt(s['resolucao']['artigos_precisao'])}"
                 f" | {_fmt(s['resolucao']['temas_recall'])} | |")
    lines.append(line)
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="eval_cases", description=__doc__.split("\n\n")[0])
    ap.add_argument("corpus", nargs="+", type=Path, help="ficheiros .pdf/.pptx/.docx do material")
    ap.add_argument("--evalset", type=Path, default=DEFAULT_EVALSET)
    ap.add_argument("-k", type=int, help="blocos recuperados por pergunta (por omissão TOP_K × 3, como o solve)")
    ap.add_argument("--solve", action="store_true", help="resolve cada pergunta com o Ollama (lento)")
    ap.add_argument("--embedder", choices=["bge-m3", "hash"], help="sobrepõe EMBEDDINGS_BACKEND")
    ap.add_argument("--out", type=Path, help="guarda o relatório completo em JSON (com as respostas)")
    args = ap.parse_args(argv)

    settings = load_settings()
    if args.embedder:
        settings = dataclasses.replace(settings, embeddings_backend=args.embedder)
    missing = [p for p in args.corpus if not p.is_file()]
    if missing:
        print(f"Ficheiros não encontrados: {', '.join(map(str, missing))}", file=sys.stderr)
        return 2
    evalset = json.loads(args.evalset.read_text(encoding="utf-8"))
    print(f"{len(evalset['itens'])} perguntas de teste, {len(args.corpus)} ficheiros no corpus")
    report = asyncio.run(run(evalset, args.corpus, settings, k=args.k, solve=args.solve))
    print()
    print(report_table(report))
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nRelatório completo: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
