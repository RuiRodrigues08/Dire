"""Estruturas comuns de ingestão, normalização de texto e contagem de tokens."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

_WORD_RE = re.compile(r"\w+|[^\w\s]", re.UNICODE)
_SENT_RE = re.compile(r"(?<=[.!?;:])\s+(?=[A-ZÀ-Ý0-9\"'(•\-])")


@dataclass
class Chunk:
    text: str
    page_number: int
    section_title: str = ""
    page_end: int | None = None
    # Metadados extra guardados no ChromaDB (só valores str/int/float/bool), por exemplo
    # a função do bloco num .docx de casos práticos: tipo, caso_id, pergunta_id, artigos, temas.
    meta: dict = field(default_factory=dict)


@dataclass
class ParseResult:
    chunks: list[Chunk] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    skipped_units: list[int] = field(default_factory=list)  # páginas/slides ignorados


def normalize(text: str) -> str:
    """Remove hífens de quebra, espaços repetidos e quebras de linha espúrias."""
    text = text.replace("­", "").replace("\x00", "")
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)          # hifenização no fim da linha
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{2,}", "\n\n", text)
    return text.strip()


def flatten(text: str) -> str:
    """Versão de uma só linha (para parágrafos de PDF partidos pelo layout)."""
    return re.sub(r"\s+", " ", text).strip()


def count_tokens(text: str) -> int:
    """Estimativa de tokens do tokenizer XLM-R (bge-m3): ~1,3 tokens por palavra/pontuação.

    Uma estimativa evita carregar o tokenizer só para cortar blocos; o erro é de
    poucos por cento e o tamanho alvo (~500) não precisa de ser exato.
    """
    return int(len(_WORD_RE.findall(text)) * 1.3) + 1


def split_sentences(text: str) -> list[str]:
    parts = [p.strip() for p in _SENT_RE.split(text) if p.strip()]
    out: list[str] = []
    for p in parts:  # frases gigantes (tabelas, listas sem pontuação) partem-se por palavras
        if count_tokens(p) > 300:
            words = p.split()
            for i in range(0, len(words), 200):
                out.append(" ".join(words[i : i + 200]))
        else:
            out.append(p)
    return out


def split_by_tokens(text: str, max_tokens: int, overlap: float = 0.0) -> list[str]:
    """Junta frases até `max_tokens`, repetindo ~`overlap` do fim no bloco seguinte."""
    sentences = split_sentences(text)
    blocks: list[str] = []
    current: list[str] = []
    size = 0
    for s in sentences:
        n = count_tokens(s)
        if current and size + n > max_tokens:
            blocks.append(" ".join(current))
            current, size = _tail(current, int(max_tokens * overlap))
        current.append(s)
        size += n
    if current:
        blocks.append(" ".join(current))
    return blocks


def _tail(sentences: list[str], budget: int) -> tuple[list[str], int]:
    tail: list[str] = []
    size = 0
    for s in reversed(sentences):
        n = count_tokens(s)
        if size + n > budget:
            break
        tail.insert(0, s)
        size += n
    return tail, size
