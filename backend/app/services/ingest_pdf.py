"""Extração de PDFs (PyMuPDF por omissão; Docling opcional via PDF_PARSER=docling).

O texto é lido por blocos, com cabeçalhos detetados pelo tamanho da letra, e
partido em blocos de ~500 tokens com 10 % de sobreposição que respeitam secções
e frases. Cada bloco guarda a página inicial e, se atravessar páginas, `page_end`.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass
from pathlib import Path

from .chunking import Chunk, ParseResult, count_tokens, flatten, split_sentences, _tail

MIN_CHARS_PER_PAGE = 40
HEADING_PAGE_RATIO = 0.85


@dataclass
class _Para:
    page: int
    text: str
    heading: bool = False


def _paras_pymupdf(path: Path, warnings: list[str], skipped: list[int]) -> list[_Para]:
    import pymupdf as fitz

    paras: list[_Para] = []
    with fitz.open(path) as doc:
        if doc.needs_pass:
            raise ValueError("O PDF está protegido por palavra-passe.")
        # Tamanho de letra dominante do documento = texto corrido.
        sizes: list[float] = []
        pages = []
        for page in doc:
            d = page.get_text("dict", sort=True)
            pages.append(d)
            for b in d["blocks"]:
                for line in b.get("lines", []):
                    for span in line["spans"]:
                        if span["text"].strip():
                            sizes.extend([round(span["size"], 1)] * len(span["text"]))
        body_size = statistics.mode(sizes) if sizes else 0

        for number, d in enumerate(pages, start=1):
            page_chars = 0
            # Maior letra da página: em slides os bullets são muitas vezes maiores que o
            # texto corrido do documento, mas só o título se aproxima deste tamanho.
            page_max = max(
                (s["size"] for b in d["blocks"] for line in b.get("lines", [])
                 for s in line["spans"] if s["text"].strip()),
                default=body_size,
            )
            for b in d["blocks"]:
                if b.get("type", 0) != 0:
                    continue
                lines = []
                block_sizes = []
                bold = True
                for line in b.get("lines", []):
                    t = "".join(s["text"] for s in line["spans"])
                    if t.strip():
                        lines.append(t)
                        block_sizes += [s["size"] for s in line["spans"] if s["text"].strip()]
                        bold = bold and all(
                            (s["flags"] & 16) for s in line["spans"] if s["text"].strip()
                        )
                text = flatten("\n".join(lines).replace("-\n", ""))
                if not text:
                    continue
                page_chars += len(text)
                size = max(block_sizes) if block_sizes else body_size
                is_heading = (
                    len(text) < 120
                    and not text.endswith((".", ",", ";", ":"))
                    and (
                        (size >= body_size * 1.15 and size >= page_max * HEADING_PAGE_RATIO)
                        or (bold and len(text) < 80)
                    )
                )
                paras.append(_Para(number, text, is_heading))
            if page_chars < MIN_CHARS_PER_PAGE:
                skipped.append(number)
    if skipped:
        warnings.append(
            "Páginas que parecem imagem (não foram lidas): " + ", ".join(map(str, skipped))
        )
    return paras


def _paras_docling(path: Path, warnings: list[str], skipped: list[int]) -> list[_Para]:
    from docling.document_converter import DocumentConverter
    from docling_core.types.doc import SectionHeaderItem, TableItem, TextItem, TitleItem

    doc = DocumentConverter().convert(str(path)).document
    paras: list[_Para] = []
    seen_pages: set[int] = set()
    for item, _level in doc.iterate_items():
        if not getattr(item, "prov", None):
            continue
        page = item.prov[0].page_no
        if isinstance(item, TableItem):
            text = item.export_to_markdown(doc)
        elif isinstance(item, TextItem):
            text = item.text
        else:
            continue
        text = text.strip()
        if not text:
            continue
        seen_pages.add(page)
        heading = isinstance(item, (SectionHeaderItem, TitleItem))
        paras.append(_Para(page, text if isinstance(item, TableItem) else flatten(text), heading))
    n_pages = len(doc.pages) if getattr(doc, "pages", None) else max(seen_pages, default=0)
    skipped.extend(p for p in range(1, n_pages + 1) if p not in seen_pages)
    if skipped:
        warnings.append(
            "Páginas que parecem imagem (não foram lidas): " + ", ".join(map(str, skipped))
        )
    return paras


def parse_pdf(
    path: str | Path, parser: str = "pymupdf", max_tokens: int = 500, overlap: float = 0.10
) -> ParseResult:
    result = ParseResult()
    path = Path(path)
    if parser == "docling":
        paras = _paras_docling(path, result.warnings, result.skipped_units)
    else:
        paras = _paras_pymupdf(path, result.warnings, result.skipped_units)

    # Unidades = (frase, página). Um cabeçalho fecha o bloco atual e passa a ser
    # o section_title dos blocos seguintes.
    section = ""
    units: list[tuple[str, int]] = []
    unit_section = ""

    def emit(units: list[tuple[str, int]], title: str) -> None:
        current: list[tuple[str, int]] = []
        size = 0
        for sent, page in units:
            n = count_tokens(sent)
            if current and size + n > max_tokens:
                _append(result, current, title)
                tail, size = _tail([s for s, _ in current], int(max_tokens * overlap))
                current = current[len(current) - len(tail):] if tail else []
            current.append((sent, page))
            size += n
        if current:
            _append(result, current, title)

    has_body = False
    for p in paras:
        if p.heading:
            if units and not has_body:
                # Cabeçalhos seguidos sem corpo (ex.: títulos de slides só com uma lista
                # curta): o texto fica no bloco em vez de ser deitado fora.
                units.append((p.text + ".", p.page))
                has_body = True
                continue
            if units:
                emit(units, unit_section)
            units, has_body = [], False
            section = p.text
            unit_section = section
            # O cabeçalho entra também no texto do bloco (ajuda o retrieval).
            units.append((p.text + ".", p.page))
            continue
        if not units:
            unit_section = section
        has_body = True
        units.extend((s, p.page) for s in split_sentences(p.text))
    if units:
        emit(units, unit_section)
    return result


def _append(result: ParseResult, current: list[tuple[str, int]], title: str) -> None:
    text = " ".join(s for s, _ in current).strip()
    if not text:
        return
    first, last = current[0][1], current[-1][1]
    result.chunks.append(
        Chunk(text=text, page_number=first, section_title=title, page_end=last if last != first else None)
    )
