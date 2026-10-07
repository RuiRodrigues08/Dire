"""Extração de PPTX slide a slide (título + pontos com nível + tabelas)."""
from __future__ import annotations

from pathlib import Path

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

from .chunking import Chunk, ParseResult, count_tokens, normalize, split_by_tokens


def _shape_lines(shape, title_shape_id) -> list[str]:
    lines: list[str] = []
    if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
        for sub in shape.shapes:
            lines.extend(_shape_lines(sub, title_shape_id))
        return lines
    if shape.shape_id == title_shape_id:
        return lines
    if getattr(shape, "has_table", False) and shape.has_table:
        for row in shape.table.rows:
            cells = [normalize(c.text).replace("\n", " ") for c in row.cells]
            if any(cells):
                lines.append("| " + " | ".join(cells) + " |")
        return lines
    if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
        for para in shape.text_frame.paragraphs:
            text = normalize("".join(run.text for run in para.runs) or para.text)
            if text:
                lines.append("  " * para.level + "- " + text.replace("\n", " "))
    return lines


def parse_pptx(path: str | Path, max_tokens: int = 800, include_notes: bool = False) -> ParseResult:
    result = ParseResult()
    prs = Presentation(str(path))
    for number, slide in enumerate(prs.slides, start=1):
        title_shape = slide.shapes.title
        title = normalize(title_shape.text).replace("\n", " ") if title_shape is not None else ""
        title_id = title_shape.shape_id if title_shape is not None else None

        body: list[str] = []
        # Ordem de leitura aproximada: de cima para baixo, da esquerda para a direita.
        shapes = sorted(slide.shapes, key=lambda s: ((s.top or 0), (s.left or 0)))
        for shape in shapes:
            body.extend(_shape_lines(shape, title_id))
        if include_notes and slide.has_notes_slide:
            notes = normalize(slide.notes_slide.notes_text_frame.text)
            if notes:
                body.append("Notas: " + notes.replace("\n", " "))

        if not title and not body:
            result.skipped_units.append(number)
            continue

        header = f"Slide {number}: {title}" if title else f"Slide {number}"
        text = header + ("\n" + "\n".join(body) if body else "")
        if count_tokens(text) <= max_tokens:
            result.chunks.append(Chunk(text=text, page_number=number, section_title=title))
        else:
            # Sub-chunks com o mesmo número de slide; o título repete-se para dar contexto.
            for part in split_by_tokens("\n".join(body), max_tokens - count_tokens(header)):
                result.chunks.append(Chunk(text=f"{header}\n{part}", page_number=number, section_title=title))

    if result.skipped_units:
        result.warnings.append(
            "Slides sem texto ignorados: " + ", ".join(map(str, result.skipped_units))
        )
    return result
