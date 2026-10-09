"""Exportar uma conversa para PDF (A4): perguntas, respostas em Markdown e fontes.

HTML → PDF com o `Story` do PyMuPDF (já é dependência para ler PDFs). O Markdown das
respostas é convertido sem HTML em bruto, e o texto das perguntas é escapado.
"""
from __future__ import annotations

import html
import io
from datetime import datetime

import pymupdf
from markdown_it import MarkdownIt

_md = MarkdownIt("commonmark", {"html": False}).enable("table").enable("strikethrough")

_CSS = """
body { font-family: sans-serif; font-size: 10.5pt; line-height: 1.45; color: #1d1d22; }
h1 { font-size: 18pt; margin: 0 0 2pt 0; color: %(accent)s; }
.meta { font-size: 9pt; color: #6b6b72; margin: 0 0 14pt 0; }
.q { font-size: 12pt; font-weight: bold; margin: 16pt 0 6pt 0; color: %(accent)s; }
.who { font-size: 8pt; font-weight: bold; color: #8a8a92; margin: 0; }
.src { font-size: 8.5pt; color: #6b6b72; margin: 4pt 0 0 0; }
table { border-collapse: collapse; }
td, th { border: 0.5pt solid #c8c8cc; padding: 2pt 4pt; }
code { font-family: monospace; font-size: 9.5pt; }
pre { font-family: monospace; font-size: 9pt; background-color: #f2f2f3; padding: 6pt; }
"""


def _sources_line(sources: list[dict] | None) -> str:
    items = []
    for s in sources or []:
        unit = "Slide" if s.get("file_type") == "pptx" else "Pág."
        items.append(f"{html.escape(str(s.get('source', '')))}, {unit} {html.escape(str(s.get('page_number', '')))}")
    return f'<p class="src">Fontes: {"; ".join(dict.fromkeys(items))}</p>' if items else ""


def conversation_pdf(title: str, messages: list[dict], accent: str = "#1E4A62") -> bytes:
    parts = [
        f"<h1>{html.escape(title)}</h1>",
        f'<p class="meta">Exportado do Dire a {datetime.now().strftime("%d/%m/%Y, %H:%M")}</p>',
    ]
    if not messages:
        parts.append('<p class="meta">Esta conversa ainda não tem mensagens.</p>')
    for m in messages:
        if m["role"] == "user":
            parts.append(f'<p class="q">{html.escape(m["content"]).replace(chr(10), "<br/>")}</p>')
        else:
            parts.append('<p class="who">DIRE</p>')
            parts.append(_md.render(m["content"] or ""))
            parts.append(_sources_line(m.get("sources")))
    story = pymupdf.Story(html="\n".join(parts), user_css=_CSS % {"accent": accent})

    buf = io.BytesIO()
    writer = pymupdf.DocumentWriter(buf)
    page = pymupdf.paper_rect("a4")
    body = page + (56, 56, -56, -56)
    more = True
    while more:
        dev = writer.begin_page(page)
        more, _ = story.place(body)
        story.draw(dev)
        writer.end_page()
    writer.close()

    # Numeração das páginas no rodapé.
    doc = pymupdf.open("pdf", buf.getvalue())
    for i, p in enumerate(doc, 1):
        p.insert_text((page.width / 2 - 12, page.height - 28), f"{i} / {doc.page_count}", fontsize=8, color=(0.55, 0.55, 0.58))
    return doc.tobytes(garbage=3, deflate=True)
