"""Pipeline de pergunta (blueprint 5): reescrita, retrieval, threshold, geração em streaming."""
from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from ..core.config import Settings
from ..core.limits import InferenceQueue
from ..core.prompts import OVERVIEW_HEADER, REFUSAL, REWRITE_PROMPT, SYSTEM_INSTRUCTIONS, USER_TEMPLATE
from .chunking import count_tokens
from .embeddings import Embedder
from .llm import Usage
from .workspace import Workspace

EXCERPT_CHARS = 400
HISTORY_ANSWER_CHARS = 300


@dataclass
class AnswerResult:
    query: str = ""
    rewritten_query: str = ""
    answer: str = ""
    sources: list[dict] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)
    refused: bool = False
    llm_called: bool = False
    context_str: str = ""


def cite_label(hit: dict) -> str:
    unit = "Slide" if hit.get("file_type") == "pptx" else "Pág."
    page = str(hit["page_number"])
    if hit.get("page_end") and hit["page_end"] != hit["page_number"]:
        page += f"-{hit['page_end']}"
    return f"{hit['source']}, {unit} {page}"


def build_context(hits: list[dict]) -> str:
    parts = []
    for i, h in enumerate(hits, start=1):
        header = f"[{i}] [{cite_label(h)}]"
        if h.get("section_title"):
            header += f" Secção: {h['section_title']}"
        parts.append(f"{header}\n{h['chunk_text']}")
    return "\n\n".join(parts)


# Margem para o template de chat do modelo e para a diferença entre a nossa
# estimativa de tokens e o tokenizer do Qwen.
PROMPT_SAFETY = 1.15
PROMPT_OVERHEAD_TOKENS = 64


def context_budget(query: str, num_ctx: int, num_predict: int) -> int:
    """Tokens disponíveis para o contexto, já descontadas as instruções, a pergunta e a margem."""
    fixed = count_tokens(SYSTEM_INSTRUCTIONS) + count_tokens(USER_TEMPLATE) + count_tokens(query)
    return int((num_ctx - num_predict - PROMPT_OVERHEAD_TOKENS) / PROMPT_SAFETY) - fixed


def fit_to_context(
    hits: list[dict], query: str, num_ctx: int, num_predict: int, reserved_tokens: int = 0
) -> list[dict]:
    """Corta os blocos menos relevantes até prompt + resposta caberem em `num_ctx`.

    Sem isto, o Ollama descarta silenciosamente o início do prompt (as instruções)
    quando o contexto transborda. Mantém sempre pelo menos o bloco mais relevante,
    exceto quando `reserved_tokens` (já ocupados por outro contexto) não deixam espaço.
    """
    fixed = count_tokens(SYSTEM_INSTRUCTIONS) + count_tokens(USER_TEMPLATE) + count_tokens(query) + reserved_tokens
    budget = num_ctx - num_predict - PROMPT_OVERHEAD_TOKENS
    kept: list[dict] = []
    used = fixed
    for h in sorted(hits, key=lambda h: h["score"], reverse=True):
        cost = count_tokens(h["chunk_text"]) + 20  # + cabeçalho [n] [ficheiro, pág.]
        if (kept or reserved_tokens) and (used + cost) * PROMPT_SAFETY > budget:
            break
        kept.append(h)
        used += cost
    return kept


# Perguntas sobre o documento inteiro (temas, títulos, resumo…): a pesquisa por
# semelhança não encontra nenhum bloco em particular, por isso respondem-se a partir
# da estrutura (títulos das secções) em vez dos TOP_K blocos mais parecidos.
OVERVIEW_RE = re.compile(
    r"\b(temas?|t[óo]picos?|t[íi]tulos?|assuntos?|resum\w*|sum[áa]rio|[íi]ndice|cap[íi]tulos?"
    r"|sec[çc][õo]es|mat[ée]ria|conte[úu]dos?|estrutura|abordad\w*|vis[ãa]o geral"
    r"|topics?|titles?|summar\w*|overview|outline|chapters?|sections|contents)\b"
    r"|\b(do|de|sobre) (o )?que (é que )?(fala|trata|é|se trata)\b"
    r"|\bwhat (is|are) (this|these|the) \w+ about\b",
    re.IGNORECASE,
)
OVERVIEW_SHARE = 0.7  # parte do orçamento do contexto para a estrutura; o resto vai para blocos
OUTLINE_EXCERPT_WORDS = (30, 12, 0)


def is_overview_question(query: str) -> bool:
    return bool(OVERVIEW_RE.search(query))


def _outline_entries(chunks: list[dict]) -> list[dict]:
    """Uma entrada por secção, pela ordem dos documentos e das páginas."""
    entries: list[dict] = []
    for c in sorted(chunks, key=lambda c: (c["source"], c["page_number"])):
        title = c.get("section_title") or ""
        last = entries[-1] if entries else None
        if last and last["source"] == c["source"] and title and last["section_title"] == title:
            last["page_end"] = max(last.get("page_end") or last["page_number"], c.get("page_end") or c["page_number"])
            continue
        text = c["chunk_text"]
        if title and text.startswith(title):
            text = text[len(title):].lstrip(". ")
        entries.append({**c, "section_title": title, "page_end": c.get("page_end"), "body": text})
    return entries


def build_outline(chunks: list[dict], max_tokens: int) -> str:
    """Estrutura dos documentos que cabe em `max_tokens`: encurta os excertos e, se ainda
    não couber, corta as últimas secções."""
    entries = _outline_entries(chunks)
    lines: list[str] = []
    for words in OUTLINE_EXCERPT_WORDS:
        lines = []
        for e in entries:
            body = e["body"].split()
            title = e["section_title"] or " ".join(body[:10])
            line = f"- [{cite_label(e)}] {title}"
            if words and body:
                line += ": " + " ".join(body[:words]) + ("…" if len(body) > words else "")
            lines.append(line)
        if count_tokens("\n".join(lines)) <= max_tokens:
            return "\n".join(lines)
    kept: list[str] = []
    used = 0
    for line in lines:
        used += count_tokens(line)
        if used > max_tokens:
            kept.append("- (…mais secções que não cabem no contexto)")
            break
        kept.append(line)
    return "\n".join(kept)


def overview_sources(chunks: list[dict]) -> list[dict]:
    """Uma fonte por documento, com o intervalo de páginas."""
    docs: dict[str, dict] = {}
    for c in chunks:
        d = docs.setdefault(c["doc_id"], {
            "source": c["source"], "file_type": c["file_type"], "page_number": c["page_number"],
            "page_end": c["page_number"], "section_title": "", "doc_id": c["doc_id"], "score": None,
            "excerpt": "",
        })
        d["page_number"] = min(d["page_number"], c["page_number"])
        d["page_end"] = max(d["page_end"], c.get("page_end") or c["page_number"])
    return sorted(docs.values(), key=lambda d: d["source"])


SUMMARY_RE = re.compile(r"\b(resum\w*|sum[áa]rio|sintetiz\w*|s[íi]ntese|summar\w*)\b", re.IGNORECASE)
# Palavras que não dizem de que tema é o resumo ("faz um resumo da matéria").
GENERIC_WORDS = set("""
a o as os um uma uns umas de da do das dos em na no nas nos por para com sobre me te se e
faz faça fazer fazes podes pode consegues consegue quero queria gostava gostaria dá dar dás
favor pf pff porfavor breve curto pequeno grande completo geral global todo toda todos todas tudo
este esta estes estas deste desta destes destas aqui
matéria materia documento documentos doc docs slides slide aula aulas apresentação apresentacao
ficheiro ficheiros pdf pdfs pptx conteúdo conteudo conteúdos conteudos texto capítulo capitulo
please give me make write the this these of an all whole entire document documents lecture
""".split())
TOPIC_MENU_INTRO = "Sobre que tema queres o resumo?"
TOPIC_TITLE_CHARS = 80
ALL_TOPICS_RE = re.compile(r"\b(tudo|todos?|todas?|geral|global|all|everything)\b", re.IGNORECASE)


def is_summary_request(query: str) -> bool:
    return bool(SUMMARY_RE.search(query))


def is_generic_summary(query: str) -> bool:
    words = re.findall(r"\w+", query.lower())
    return all(w in GENERIC_WORDS or SUMMARY_RE.fullmatch(w) for w in words)


def topic_menu(entries: list[dict]) -> str:
    lines = [TOPIC_MENU_INTRO + " Os documentos abordam:", ""]
    for i, e in enumerate(entries, start=1):
        title = e["section_title"] or " ".join(e["body"].split()[:10])
        if len(title) > TOPIC_TITLE_CHARS:
            title = title[:TOPIC_TITLE_CHARS].rstrip() + "…"
        lines.append(f"{i}. {title} [{cite_label(e)}]")
    lines += ["", 'Responde com o número ou o nome de um ou mais temas (por exemplo "2 e 5" ou '
                  '"services"), ou "tudo" para um resumo geral.']
    return "\n".join(lines)


def parse_topic_choice(query: str, entries: list[dict]) -> list[dict] | str | None:
    """Interpreta a resposta ao menu: "all", a lista de secções escolhidas, ou None se
    parecer outra pergunta (segue o caminho normal)."""
    numbers = [int(n) for n in re.findall(r"\b\d{1,3}\b", query)]
    for a, b in re.findall(r"\b(\d{1,3})\s*(?:-|a|até)\s*(\d{1,3})\b", query):
        numbers += list(range(int(a), int(b) + 1))
    chosen = sorted({n for n in numbers if 1 <= n <= len(entries)})
    if chosen:
        return [entries[n - 1] for n in chosen]
    if ALL_TOPICS_RE.search(query):
        return "all"
    if query.rstrip().endswith("?"):
        return None
    words = [w for w in re.findall(r"\w+", query.lower()) if len(w) >= 3 and w not in GENERIC_WORDS]
    matched = [e for e in entries if any(w in e["section_title"].lower() for w in words)]
    return matched or None


def sections_chunks(all_chunks: list[dict], entries: list[dict]) -> list[dict]:
    """Todos os blocos das secções escolhidas, pela ordem das páginas."""
    out = []
    for c in sorted(all_chunks, key=lambda c: (c["source"], c["page_number"])):
        for e in entries:
            if (c["source"] == e["source"] and (c.get("section_title") or "") == e["section_title"]
                    and e["page_number"] <= c["page_number"] <= (e.get("page_end") or e["page_number"])):
                out.append(c)
                break
    return out


def fit_in_order(chunks: list[dict], max_tokens: int) -> list[dict]:
    """Mantém os blocos pela ordem dada enquanto couberem (pelo menos o primeiro)."""
    kept, used = [], 0
    for c in chunks:
        used += count_tokens(c["chunk_text"]) + 20
        if kept and used > max_tokens:
            break
        kept.append(c)
    return kept


def format_history(history: list[dict]) -> str:
    lines = []
    for m in history:
        if m["role"] == "user":
            lines.append(f"Utilizador: {m['content']}")
        else:
            text = " ".join(m["content"].split())
            if len(text) > HISTORY_ANSWER_CHARS:
                text = text[:HISTORY_ANSWER_CHARS] + "…"
            lines.append(f"Assistente: {text}")
    return "\n".join(lines)


def _clean_rewrite(text: str, fallback: str) -> str:
    lines = [l.strip() for l in text.strip().splitlines() if l.strip()]
    if not lines:
        return fallback
    out = lines[0]
    for prefix in ("Pergunta reescrita:", "PERGUNTA REESCRITA:", "Pergunta:"):
        if out.startswith(prefix):
            out = out[len(prefix):].strip()
    out = out.strip('"“”\'« »')
    return out[:1000] or fallback


class RagEngine:
    def __init__(self, settings: Settings, llm, embedder: Embedder, queue: InferenceQueue):
        self.s = settings
        self.llm = llm
        self.embedder = embedder
        self.queue = queue

    async def retrieve(
        self, ws: Workspace, conversation_id: str, query: str, doc_ids=None, k: int | None = None
    ) -> list[dict]:
        emb = await asyncio.to_thread(self.embedder.embed_query, query)
        return await asyncio.to_thread(ws.vectors.query, emb, conversation_id, k or self.s.top_k, doc_ids)

    async def rewrite(self, query: str, history: list[dict], usage: Usage) -> str:
        if not history:
            return query
        prompt = REWRITE_PROMPT.format(history_str=format_history(history), query_str=query)
        text, u = await self.llm.complete([{"role": "user", "content": prompt}], self.s.rewrite_num_predict)
        usage += u
        return _clean_rewrite(text, query)

    async def answer(
        self, ws: Workspace, conversation_id: str, query: str, history: list[dict],
        result: AnswerResult, doc_ids: list[str] | None = None,
    ) -> AsyncIterator[dict]:
        """Gera eventos NDJSON (5.3) e preenche `result` para o chamador gravar.

        Quatro caminhos: pergunta específica (TOP_K blocos), pergunta geral (estrutura
        dos documentos), pedido de resumo sem tema (devolve o menu de temas, sem LLM) e
        resumo de temas escolhidos (todo o texto dessas secções, com resposta mais longa).
        """
        result.query = query
        ticket = self.queue.take_ticket()
        try:
            while (pos := self.queue.position(ticket)) > 0:
                yield {"type": "queue", "position": pos}
                await self.queue.wait_for_change()

            async with asyncio.timeout(self.s.inference_timeout_seconds):
                async for ev in self._answer(ws, conversation_id, query, history, result, doc_ids):
                    yield ev
        finally:
            self.queue.release(ticket)

    async def _answer(self, ws, conversation_id, query, history, result, doc_ids) -> AsyncIterator[dict]:
        all_chunks: list[dict] = []

        async def load_all() -> list[dict]:
            nonlocal all_chunks
            if not all_chunks:
                all_chunks = await asyncio.to_thread(ws.vectors.all_chunks, conversation_id, doc_ids)
            return all_chunks

        # 1. Resposta ao menu de temas ("2 e 5", "services", "tudo"): sem reescrita.
        if history and history[-1]["role"] == "assistant" and history[-1]["content"].startswith(TOPIC_MENU_INTRO):
            entries = _outline_entries(await load_all())
            choice = parse_topic_choice(query, entries)
            if choice == "all":
                result.rewritten_query = "Faz um resumo geral e desenvolvido de toda a matéria dos documentos."
                yield {"type": "rewrite", "data": result.rewritten_query}
                async for ev in self._overview(result, all_chunks, self.s.summary_num_predict):
                    yield ev
                return
            if choice:
                titles = "; ".join(e["section_title"] or e["body"][:60] for e in choice)
                result.rewritten_query = (
                    f"Faz um resumo detalhado e bem desenvolvido sobre: {titles}. "
                    "Explica cada ponto com base no contexto."
                )
                yield {"type": "rewrite", "data": result.rewritten_query}
                chunks = sections_chunks(all_chunks, choice)
                async for ev in self._generate(result, chunks, "", self.s.summary_num_predict, scored=False):
                    yield ev
                return

        # 2. Resumo sem tema: devolve a lista de temas para o utilizador escolher. Decide-se
        # pelo texto original, antes da reescrita (que tende a acrescentar "da matéria abordada").
        # "Resume isso" refere-se à conversa e não é genérico (isso/disso não estão em GENERIC_WORDS).
        if is_summary_request(query) and is_generic_summary(query):
            entries = _outline_entries(await load_all())
            if entries:
                result.rewritten_query = query
                result.answer = topic_menu(entries)
                result.sources = overview_sources(all_chunks)
                yield {"type": "token", "data": result.answer}
                yield {"type": "sources", "data": result.sources}
                return

        result.rewritten_query = await self.rewrite(query, history, result.usage)
        if result.rewritten_query != query:
            yield {"type": "rewrite", "data": result.rewritten_query}
        q = result.rewritten_query

        # 3. Resumo de um tema dito por extenso: mais blocos e resposta mais longa.
        if is_summary_request(q):
            hits = await self.retrieve(ws, conversation_id, q, doc_ids, k=self.s.top_k * 2)
            hits = [h for h in hits if h["score"] >= self.s.score_threshold]
            if hits:
                async for ev in self._generate(result, hits, "", self.s.summary_num_predict):
                    yield ev
                return

        hits = await self.retrieve(ws, conversation_id, q, doc_ids)
        hits = [h for h in hits if h["score"] >= self.s.score_threshold]

        # 4. Pergunta geral: estrutura dos documentos (+ blocos relevantes, se houver).
        if is_overview_question(query) or is_overview_question(q):
            if await load_all():
                async for ev in self._overview(result, all_chunks, self.s.num_predict, hits):
                    yield ev
                return

        if not hits:
            # Sem contexto suficiente: recusa padrão sem chamar o LLM de geração.
            result.answer, result.refused = REFUSAL, True
            yield {"type": "token", "data": REFUSAL}
            yield {"type": "sources", "data": []}
            return
        async for ev in self._generate(result, hits, "", self.s.num_predict):
            yield ev

    async def _overview(self, result, all_chunks, num_predict, hits=()) -> AsyncIterator[dict]:
        budget = context_budget(result.rewritten_query, self.s.num_ctx, num_predict)
        outline = OVERVIEW_HEADER + "\n" + build_outline(all_chunks, int(budget * OVERVIEW_SHARE))
        async for ev in self._generate(result, list(hits), outline, num_predict,
                                       extra_sources=overview_sources(all_chunks)):
            yield ev

    async def _generate(
        self, result: AnswerResult, hits: list[dict], outline: str, num_predict: int,
        scored: bool = True, extra_sources: list[dict] | None = None,
    ) -> AsyncIterator[dict]:
        q = result.rewritten_query
        reserved = count_tokens(outline) if outline else 0
        if scored:
            hits = fit_to_context(hits, q, self.s.num_ctx, num_predict, reserved_tokens=reserved)
        else:
            hits = fit_in_order(hits, context_budget(q, self.s.num_ctx, num_predict) - reserved)
        result.context_str = "\n\n".join(p for p in (outline, build_context(hits)) if p)
        messages = [
            {"role": "system", "content": SYSTEM_INSTRUCTIONS},
            {"role": "user", "content": USER_TEMPLATE.format(context_str=result.context_str, query_str=q)},
        ]
        result.llm_called = True
        pieces: list[str] = []
        async for piece in self.llm.stream(messages, num_predict, result.usage):
            pieces.append(piece)
            yield {"type": "token", "data": piece}
        result.answer = "".join(pieces).strip()
        result.refused = result.answer.startswith(REFUSAL[:60])
        result.sources = [] if result.refused else [
            {
                "source": h["source"], "file_type": h["file_type"], "page_number": h["page_number"],
                "page_end": h.get("page_end"), "section_title": h.get("section_title", ""),
                "doc_id": h["doc_id"], "score": round(h["score"], 4) if scored else None,
                "excerpt": h["chunk_text"][:EXCERPT_CHARS],
            }
            for h in hits
        ] + (extra_sources or [])
        yield {"type": "sources", "data": result.sources}
