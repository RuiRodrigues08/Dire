"""Ingestão de .docx com a função de cada bloco e extração de artigos/temas."""
from app.services.ingest_docx import parse_docx, summarize_structure
from app.services.legal_refs import article_bases, extract_articles, tag_topics

from .fixtures import make_cases_docx, make_theory_docx


def _by(chunks, **kw):
    return [c for c in chunks if all(c.meta.get(k) == v for k, v in kw.items())]


def test_cases_split_into_questions_and_answers(tmp_path):
    r = parse_docx(make_cases_docx(tmp_path / "aulas.docx"))
    s = summarize_structure(r)
    assert s["casos"] == 3 and s["perguntas"] == 4
    assert "teoria" not in s["por_tipo"]                       # cabeçalho solto "Aulas TP" não vira bloco

    q1 = _by(r.chunks, tipo="pergunta", pergunta_id="I.1")[0]
    assert "Enunciado: Alberto celebrou" in q1.text and "trabalhava obrigatoriamente" in q1.text
    assert q1.text.endswith("Pergunta: Quid iuris?")           # "Imagine que …:" fica no enunciado

    # Duas versões da resolução, pela ordem do documento: tópicos e depois a resposta completa.
    answers = _by(r.chunks, tipo="resposta", pergunta_id="I.1")
    assert [a.meta["variante"] for a in answers] == ["esquema", "completa"]
    assert "art. 12.º/1 CT" in answers[1].meta["artigos"]
    assert "qualificacao" in answers[0].meta["temas"]


def test_numbered_questions_and_exam_group(tmp_path):
    r = parse_docx(make_cases_docx(tmp_path / "aulas.docx"))
    q = _by(r.chunks, tipo="pergunta", caso_id="II")
    assert [c.meta["pergunta_id"] for c in q] == ["II.1", "II.2"]
    assert "Glória foi contratada" in q[1].text                # o enunciado repete-se em cada pergunta
    a2 = _by(r.chunks, tipo="resposta", pergunta_id="II.2")[0]
    assert a2.meta["artigos"] == "art. 141.º CT; art. 147.º/1/c) CT"
    assert "termo_certo" in a2.meta["temas"]

    exam = _by(r.chunks, caso_id="1-exame-parcelar-2023-10-23/IV")
    assert len(exam) == 1 and exam[0].meta["tipo"] == "pergunta"
    assert exam[0].meta["cotacao"] == "4 valores"
    assert exam[0].section_title.startswith("1.º exame parcelar — 2023/10/23 – IV")
    assert any("sem resolução" in w for w in r.warnings)
    assert [c.page_number for c in r.chunks] == list(range(1, len(r.chunks) + 1))


def test_theory_sections_from_heading_styles_bold_and_tables(tmp_path):
    r = parse_docx(make_theory_docx(tmp_path / "rm.docx"))
    assert [c.section_title for c in r.chunks] == ["Período experimental", "Teletrabalho"]
    assert all(c.meta["tipo"] == "teoria" for c in r.chunks)
    assert r.chunks[0].text.startswith("Período experimental. O período experimental")
    assert r.chunks[0].meta["temas"] == "periodo_experimental"
    assert "| Termo ≥ 6 meses | 30 dias |" in r.chunks[1].text


def test_extract_articles_citation_styles():
    def arts(t):
        return [str(a) for a in extract_articles(t)]

    assert arts("Art.º 1152º e 1153º CC e 11º CT – elementos") == [
        "art. 1152.º CC", "art. 1153.º CC", "art. 11.º CT"]
    assert arts("nos termos do artigo 3º nº4 do CT") == ["art. 3.º/4 CT"]
    assert arts("(art.º 140º/1/2), nem (art.º 140º/4)") == ["art. 140.º/1/2 CT", "art. 140.º/4 CT"]
    assert arts("nos termos do art.º 112º/2/a).") == ["art. 112.º/2/a) CT"]
    assert arts("artigos 53º a 59º da CRP") == ["art. 53.º CRP", "art. 59.º CRP"]
    assert arts("arts. 111.º e 114.º, n.º 1") == ["art. 111.º CT", "art. 114.º/1 CT"]
    assert arts("o artigo 166.º-A do CT") == ["art. 166.º-A CT"]
    # Sem diploma: até 566 é do CT, acima disso do Código Civil.
    assert [a.diploma for a in extract_articles("art.º 140º e art.º 1155º")] == ["CT", "CC"]
    assert article_bases("art.º 12º/1 CT e art. 12.º CT") == ["12 CT"]


def test_tag_topics_keywords_and_articles():
    assert tag_topics("O período experimental tem a duração de 90 dias.") == ["periodo_experimental"]
    assert tag_topics("Nos termos do art.º 120º CT o empregador pode…") == ["mobilidade_funcional"]
    assert "qualificacao" in tag_topics("Presunção de laboralidade e subordinação jurídica")
    assert tag_topics("Texto sem nada de jurídico.") == []
