"""Ferramentas de casos práticos: criar uma resposta-modelo e resolver um caso novo.

Resposta-modelo (análise por partes): o LLM analisa a estrutura da resolução de cada
documento escolhido (uma chamada por documento, guardada em `doc_analyses`) e depois junta
as análises num esqueleto comum (guardado em `model_answers` para o mesmo conjunto).

Resolver caso: usa a resposta-modelo dos documentos de referência, os excertos desses
documentos mais parecidos com o caso novo e o próprio caso, e escreve a resolução.
Ao contrário do chat, aqui o modelo aplica regras a factos novos (inferência), por isso
a interface marca a resposta como rascunho a verificar.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from ..core.config import Settings
from ..core.db import connect, utcnow
from ..core.limits import InferenceQueue
from ..core.prompts import (
    MODEL_ANSWER_PROMPT, MODEL_ANSWER_SYSTEM, SOLVE_PROMPT, SOLVE_SYSTEM, STRUCTURE_PROMPT,
)
from .chunking import count_tokens
from .embeddings import Embedder
from .rag_engine import (
    EXCERPT_CHARS, PROMPT_OVERHEAD_TOKENS, PROMPT_SAFETY, AnswerResult, build_context, overview_sources,
)
from .workspace import Workspace

ANALYSIS_KIND = "structure"
ANALYSIS_NUM_PREDICT = 400
MODEL_ANSWER_NUM_PREDICT = 900
MAX_CASE_TOKENS = 1500     # o resto do contexto fica para a resposta-modelo e os excertos
MAX_TEMPLATE_TOKENS = 1200
MAX_CASE_CHARS = 12000

MODEL_ANSWER_LABEL = "Criar resposta-modelo"
SOLVE_LABEL = "Resolver caso prático"


def _budget(num_ctx: int, num_predict: int, *fixed_texts: str) -> int:
    """Tokens livres para texto variável, já descontadas as partes fixas e a margem."""
    fixed = sum(count_tokens(t) for t in fixed_texts)
    return int((num_ctx - num_predict - PROMPT_OVERHEAD_TOKENS) / PROMPT_SAFETY) - fixed


def _take(chunks: list[dict], max_tokens: int) -> tuple[list[dict], bool]:
    """Blocos pela ordem dada enquanto couberem; devolve também se ficou algo de fora."""
    kept, used = [], 0
    for c in chunks:
        used += count_tokens(c["chunk_text"]) + 20
        if kept and used > max_tokens:
            return kept, True
        kept.append(c)
    return kept, False


def _trim_text(text: str, max_tokens: int) -> tuple[str, bool]:
    if count_tokens(text) <= max_tokens:
        return text, False
    words = text.split()
    keep = int(max_tokens / 1.3)
    return " ".join(words[:keep]) + " […]", True


def doc_key(doc_ids: list[str]) -> str:
    return ",".join(sorted(set(doc_ids)))


def _get_analysis(ws: Workspace, doc_id: str) -> str | None:
    with connect(ws.db_path) as db:
        row = db.execute(
            "SELECT content FROM doc_analyses WHERE doc_id=? AND kind=?", (doc_id, ANALYSIS_KIND)
        ).fetchone()
    return row["content"] if row else None


def _save_analysis(ws: Workspace, doc_id: str, content: str) -> None:
    with connect(ws.db_path) as db:
        db.execute(
            "INSERT OR REPLACE INTO doc_analyses (doc_id, kind, content, created_at) VALUES (?,?,?,?)",
            (doc_id, ANALYSIS_KIND, content, utcnow()),
        )


def get_model_answer(ws: Workspace, conversation_id: str, doc_ids: list[str]) -> str | None:
    with connect(ws.db_path) as db:
        row = db.execute(
            "SELECT content FROM model_answers WHERE conversation_id=? AND doc_key=?",
            (conversation_id, doc_key(doc_ids)),
        ).fetchone()
    return row["content"] if row else None


def _save_model_answer(ws: Workspace, conversation_id: str, doc_ids: list[str], content: str) -> None:
    with connect(ws.db_path) as db:
        db.execute(
            "INSERT OR REPLACE INTO model_answers (conversation_id, doc_key, content, created_at)"
            " VALUES (?,?,?,?)",
            (conversation_id, doc_key(doc_ids), content, utcnow()),
        )


def _doc_chunks(ws: Workspace, conversation_id: str, doc_ids: list[str]) -> dict[str, list[dict]]:
    """Blocos de cada documento, pela ordem das páginas."""
    out: dict[str, list[dict]] = {d: [] for d in doc_ids}
    for c in ws.vectors.all_chunks(ws.scopes(conversation_id), doc_ids):
        out.setdefault(c["doc_id"], []).append(c)
    for chunks in out.values():
        chunks.sort(key=lambda c: c["page_number"])
    return out


def _progress(message: str) -> dict:
    return {"type": "progress", "message": message}


class CaseTools:
    def __init__(self, settings: Settings, llm, embedder: Embedder, queue: InferenceQueue):
        self.s = settings
        self.llm = llm
        self.embedder = embedder
        self.queue = queue

    async def _in_queue(self, inner: AsyncIterator[dict]) -> AsyncIterator[dict]:
        """Mesma fila de inferência do chat (1 de cada vez), com a posição enquanto espera."""
        ticket = self.queue.take_ticket()
        try:
            while (pos := self.queue.position(ticket)) > 0:
                yield {"type": "queue", "position": pos}
                await self.queue.wait_for_change()
            async for ev in inner:
                yield ev
        finally:
            self.queue.release(ticket)

    # ---------- resposta-modelo ----------

    def model_answer(
        self, ws: Workspace, conversation_id: str, docs: list[dict], result: AnswerResult
    ) -> AsyncIterator[dict]:
        return self._in_queue(self._model_answer(ws, conversation_id, docs, result))

    async def _model_answer(self, ws, conversation_id, docs, result) -> AsyncIterator[dict]:
        ids = [d["id"] for d in docs]
        chunks = await asyncio.to_thread(_doc_chunks, ws, conversation_id, ids)
        result.rewritten_query = f"{MODEL_ANSWER_LABEL} com base em {len(docs)} documento(s)"

        cached = await asyncio.to_thread(get_model_answer, ws, conversation_id, ids)
        if cached:
            yield _progress("Já existia uma resposta-modelo para estes documentos.")
            result.answer = cached
            yield {"type": "token", "data": cached}
        else:
            analyses: list[tuple[str, str]] = []
            async for ev in self._analyses(ws, docs, chunks, result, analyses):
                yield ev
            yield _progress("A juntar as análises numa resposta-modelo…")
            text = "\n\n".join(f"### Resolução {i}: {name}\n{a}" for i, (name, a) in enumerate(analyses, 1))
            messages = [
                {"role": "system", "content": MODEL_ANSWER_SYSTEM},
                {"role": "user", "content": MODEL_ANSWER_PROMPT.format(analyses=text)},
            ]
            result.llm_called = True
            pieces: list[str] = []
            async with asyncio.timeout(self.s.inference_timeout_seconds):
                async for piece in self.llm.stream(messages, MODEL_ANSWER_NUM_PREDICT, result.usage,
                                                   num_ctx=self.s.tools_num_ctx):
                    pieces.append(piece)
                    yield {"type": "token", "data": piece}
            result.answer = "".join(pieces).strip()
            await asyncio.to_thread(_save_model_answer, ws, conversation_id, ids, result.answer)

        result.sources = overview_sources([c for cs in chunks.values() for c in cs])
        yield {"type": "sources", "data": result.sources}

    async def _analyses(self, ws, docs, chunks, result, out: list) -> AsyncIterator[dict]:
        """Análise da estrutura de cada documento (guardada: só se faz uma vez por documento)."""
        n = len(docs)
        for i, d in enumerate(docs, 1):
            cached = await asyncio.to_thread(_get_analysis, ws, d["id"])
            if cached:
                yield _progress(f"Análise de {d['filename']} já feita ({i}/{n}).")
                out.append((d["filename"], cached))
                continue
            yield _progress(f"A analisar a estrutura de {d['filename']} ({i}/{n})…")
            budget = _budget(self.s.tools_num_ctx, ANALYSIS_NUM_PREDICT, STRUCTURE_PROMPT)
            kept, cut = _take(chunks.get(d["id"], []), budget)
            text = build_context(kept) + ("\n\n[… o resto do documento não coube]" if cut else "")
            prompt = STRUCTURE_PROMPT.format(filename=d["filename"], text=text)
            result.llm_called = True
            async with asyncio.timeout(self.s.inference_timeout_seconds):
                analysis, usage = await self.llm.complete(
                    [{"role": "user", "content": prompt}], ANALYSIS_NUM_PREDICT, num_ctx=self.s.tools_num_ctx)
            result.usage += usage
            analysis = analysis.strip()
            await asyncio.to_thread(_save_analysis, ws, d["id"], analysis)
            out.append((d["filename"], analysis))

    async def _template(self, ws, conversation_id, docs, chunks, result) -> AsyncIterator[dict]:
        """Resposta-modelo para os documentos de referência, sem a mostrar (para resolver)."""
        ids = [d["id"] for d in docs]
        cached = await asyncio.to_thread(get_model_answer, ws, conversation_id, ids)
        if cached:
            result.context_str = cached
            return
        analyses: list[tuple[str, str]] = []
        async for ev in self._analyses(ws, docs, chunks, result, analyses):
            yield ev
        yield _progress("A criar a resposta-modelo dos documentos de referência…")
        text = "\n\n".join(f"### Resolução {i}: {name}\n{a}" for i, (name, a) in enumerate(analyses, 1))
        async with asyncio.timeout(self.s.inference_timeout_seconds):
            template, usage = await self.llm.complete(
                [{"role": "system", "content": MODEL_ANSWER_SYSTEM},
                 {"role": "user", "content": MODEL_ANSWER_PROMPT.format(analyses=text)}],
                MODEL_ANSWER_NUM_PREDICT, num_ctx=self.s.tools_num_ctx)
        result.usage += usage
        template = template.strip()
        await asyncio.to_thread(_save_model_answer, ws, conversation_id, ids, template)
        result.context_str = template

    # ---------- resolver um caso novo ----------

    def solve(
        self, ws: Workspace, conversation_id: str, refs: list[dict], case_text: str | None,
        case_doc: dict | None, result: AnswerResult,
    ) -> AsyncIterator[dict]:
        return self._in_queue(self._solve(ws, conversation_id, refs, case_text, case_doc, result))

    async def _solve(self, ws, conversation_id, refs, case_text, case_doc, result) -> AsyncIterator[dict]:
        ref_ids = [d["id"] for d in refs]
        chunks = await asyncio.to_thread(
            _doc_chunks, ws, conversation_id, ref_ids + ([case_doc["id"]] if case_doc else []))
        result.rewritten_query = f"{SOLVE_LABEL} com base em {len(refs)} documento(s)"

        # 1. Estrutura a seguir (resposta-modelo dos documentos de referência).
        async for ev in self._template(ws, conversation_id, refs, chunks, result):
            yield ev
        template, _ = _trim_text(result.context_str, MAX_TEMPLATE_TOKENS)

        # 2. O caso novo: texto colado ou um documento carregado.
        if case_doc:
            case_text = "\n".join(c["chunk_text"] for c in chunks.get(case_doc["id"], []))
        case, cut = _trim_text(case_text or "", MAX_CASE_TOKENS)
        if cut:
            yield _progress("O enunciado é longo: só a primeira parte coube no contexto.")

        # 3. Excertos dos documentos de referência mais parecidos com o caso.
        yield _progress("A procurar a matéria e os casos parecidos…")
        emb = await asyncio.to_thread(self.embedder.embed_query, case[:4000])
        hits = await asyncio.to_thread(ws.vectors.query, emb, ws.scopes(conversation_id), self.s.top_k * 3, ref_ids)
        budget = _budget(self.s.tools_num_ctx, self.s.summary_num_predict,
                         SOLVE_SYSTEM, SOLVE_PROMPT, template, case)
        hits, _ = _take(hits, budget)
        result.context_str = build_context(hits)

        # 4. Resolução.
        yield _progress("A escrever a resolução…")
        messages = [
            {"role": "system", "content": SOLVE_SYSTEM},
            {"role": "user", "content": SOLVE_PROMPT.format(
                template=template, context=result.context_str or "(nenhum excerto)", case=case)},
        ]
        result.llm_called = True
        pieces: list[str] = []
        async with asyncio.timeout(self.s.inference_timeout_seconds * 2):
            async for piece in self.llm.stream(messages, self.s.summary_num_predict, result.usage,
                                               num_ctx=self.s.tools_num_ctx):
                pieces.append(piece)
                yield {"type": "token", "data": piece}
        result.answer = "".join(pieces).strip()
        result.sources = [
            {
                "source": h["source"], "file_type": h["file_type"], "page_number": h["page_number"],
                "page_end": h.get("page_end"), "section_title": h.get("section_title", ""),
                "doc_id": h["doc_id"], "score": round(h["score"], 4),
                "excerpt": h["chunk_text"][:EXCERPT_CHARS],
            }
            for h in hits
        ]
        yield {"type": "sources", "data": result.sources}

