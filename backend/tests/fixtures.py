"""Gera PDFs e PPTX de teste (sem ficheiros binários no repositório)."""
from __future__ import annotations

from pathlib import Path

import pymupdf as fitz
from pptx import Presentation
from pptx.util import Inches

ML_PAGES = [
    ("Introdução à Aprendizagem Automática",
     "A aprendizagem automática estuda algoritmos que aprendem padrões a partir de dados. "
     "Um modelo é treinado com um conjunto de treino e avaliado num conjunto de teste."),
    ("Overfitting",
     "O overfitting acontece quando um modelo memoriza o ruído do conjunto de treino. "
     "O modelo sobreajustado tem erro de treino baixo mas erro de teste elevado. "
     "O overfitting é mais provável em modelos com muitos parâmetros e poucos dados."),
    ("Como evitar o overfitting",
     "Para evitar o overfitting usa-se regularização L2, dropout e paragem antecipada. "
     "A validação cruzada ajuda a escolher hiperparâmetros sem tocar no conjunto de teste. "
     "Aumentar a quantidade de dados de treino também reduz o sobreajuste."),
]


def make_pdf(path: Path, pages=ML_PAGES, blank_page: bool = True, filler_paragraphs: int = 0) -> Path:
    doc = fitz.open()
    for title, body in pages:
        page = doc.new_page()
        page.insert_text((72, 72), title, fontsize=18, fontname="hebo")
        text = body + (" " + body) * filler_paragraphs
        page.insert_textbox(fitz.Rect(72, 100, 520, 800), text, fontsize=11, fontname="helv")
    if blank_page:
        doc.new_page()  # página "digitalizada" sem texto
    doc.save(path)
    doc.close()
    return path


def make_pptx(path: Path, long_slide_words: int = 0) -> Path:
    prs = Presentation()
    s1 = prs.slides.add_slide(prs.slide_layouts[1])
    s1.shapes.title.text = "Redes neuronais"
    tf = s1.placeholders[1].text_frame
    tf.text = "Um perceptrão combina entradas com pesos"
    p = tf.add_paragraph()
    p.text = "A função de ativação introduz não-linearidade"
    p.level = 1

    s2 = prs.slides.add_slide(prs.slide_layouts[5])
    s2.shapes.title.text = "Comparação de otimizadores"
    table = s2.shapes.add_table(3, 2, Inches(1), Inches(2), Inches(6), Inches(2)).table
    for r, row in enumerate([("Otimizador", "Taxa típica"), ("SGD", "0.01"), ("Adam", "0.001")]):
        for c, val in enumerate(row):
            table.cell(r, c).text = val

    prs.slides.add_slide(prs.slide_layouts[6])  # slide vazio

    if long_slide_words:
        s4 = prs.slides.add_slide(prs.slide_layouts[1])
        s4.shapes.title.text = "Slide muito longo"
        words = " ".join(f"palavra{i}" for i in range(long_slide_words))
        s4.placeholders[1].text_frame.text = words
    prs.save(path)
    return path
