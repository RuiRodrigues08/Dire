from app.core.prompts import REFUSAL
from app.services.chunking import count_tokens, normalize, split_by_tokens
from app.services.ingest_pdf import parse_pdf
from app.services.ingest_ppt import parse_pptx

from .fixtures import make_pdf, make_pptx


def test_pdf_pages_headings_and_scanned_warning(tmp_path):
    r = parse_pdf(make_pdf(tmp_path / "ml.pdf"))
    assert [c.page_number for c in r.chunks] == [1, 2, 3]
    assert r.chunks[1].section_title == "Overfitting"
    assert r.chunks[2].text.startswith("Como evitar o overfitting.")
    assert r.skipped_units == [4]
    assert "4" in r.warnings[0]


def test_pdf_long_sections_split_with_overlap(tmp_path):
    r = parse_pdf(make_pdf(tmp_path / "big.pdf", blank_page=False, filler_paragraphs=12), max_tokens=200)
    page2 = [c for c in r.chunks if c.page_number == 2]
    assert len(page2) >= 2
    assert all(count_tokens(c.text) <= 260 for c in r.chunks)
    # 10 % de sobreposição: o início do bloco seguinte repete o fim do anterior
    last_sentence = page2[0].text.rsplit(". ", 1)[-1]
    assert last_sentence[:30] in page2[1].text


def test_pdf_chunk_crossing_pages_has_page_end(tmp_path):
    import pymupdf

    doc = pymupdf.open()
    for i in range(2):
        page = doc.new_page()
        page.insert_textbox(pymupdf.Rect(72, 72, 520, 800),
                            f"Parágrafo número {i} sobre gradientes e otimização estocástica.", fontsize=11)
    doc.save(tmp_path / "x.pdf")
    r = parse_pdf(tmp_path / "x.pdf")
    assert len(r.chunks) == 1
    assert (r.chunks[0].page_number, r.chunks[0].page_end) == (1, 2)


def test_pptx_slides_tables_empty_and_long(tmp_path):
    r = parse_pptx(make_pptx(tmp_path / "nn.pptx", long_slide_words=900), max_tokens=800)
    pages = [c.page_number for c in r.chunks]
    assert pages[:2] == [1, 2] and 3 not in pages
    assert pages.count(4) >= 2  # slide longo dividido com o mesmo número
    assert "  - A função de ativação" in r.chunks[0].text  # nível do ponto preservado
    assert "| Adam | 0.001 |" in r.chunks[1].text
    assert r.chunks[1].section_title == "Comparação de otimizadores"
    assert r.skipped_units == [3]


def test_normalize_and_split():
    assert normalize("a  b\n\n\n\nc-\nd ") == "a b\n\ncd"
    blocks = split_by_tokens("Frase um. " * 200, max_tokens=50, overlap=0.1)
    assert len(blocks) > 5
    assert REFUSAL.startswith("Com base nos documentos fornecidos")


def test_fit_to_context_drops_least_relevant_chunks():
    from app.services.rag_engine import fit_to_context

    big = "palavra " * 450  # ~600 tokens estimados
    hits = [{"chunk_text": big, "score": 0.9 - i * 0.05} for i in range(4)]
    assert len(fit_to_context(hits, "pergunta", num_ctx=4096, num_predict=500)) == 4
    kept = fit_to_context(hits, "pergunta", num_ctx=2048, num_predict=500)
    assert 1 <= len(kept) < 4 and kept[0]["score"] == 0.9
    assert len(fit_to_context(hits, "pergunta", num_ctx=600, num_predict=500)) == 1


def test_overview_detection_and_outline_budget():
    from app.services.rag_engine import build_outline, is_overview_question

    for q in ("Quais os temas abordados?", "Quais são os títulos?", "Faz um resumo",
              "Do que fala este documento?", "What topics are covered?"):
        assert is_overview_question(q), q
    for q in ("O que é overfitting?", "Como se evita o sobreajuste?", "Qual é a capital de França?"):
        assert not is_overview_question(q), q

    chunks = [
        {"source": "a.pdf", "file_type": "pdf", "page_number": p, "section_title": f"Secção {p}",
         "chunk_text": f"Secção {p}. " + "palavra " * 100}
        for p in range(60, 0, -1)
    ]
    full = build_outline(chunks, max_tokens=100_000)
    assert full.index("Secção 1:") < full.index("Secção 2:") < full.index("Secção 60:")
    short = build_outline(chunks, max_tokens=300)
    assert "Secção 1" in short and "mais secções" in short


def test_summary_detection_and_topic_choice():
    from app.services.rag_engine import is_generic_summary, is_summary_request, parse_topic_choice

    for q in ("Faz um resumo", "resume a matéria", "Podes fazer um resumo dos slides?", "summarize the document"):
        assert is_summary_request(q) and is_generic_summary(q), q
    for q in ("Resume os services", "resume isso", "Faz um resumo do overfitting"):
        assert is_summary_request(q) and not is_generic_summary(q), q

    entries = [{"section_title": t} for t in ("Intro", "The sauce: Services", "The sauce: Activities", "ADB")]
    assert parse_topic_choice("2 e 4", entries) == [entries[1], entries[3]]
    assert parse_topic_choice("1-3", entries) == entries[:3]
    assert parse_topic_choice("tudo", entries) == "all"
    assert parse_topic_choice("services", entries) == [entries[1]]
    assert parse_topic_choice("O que é um intent?", entries) is None
