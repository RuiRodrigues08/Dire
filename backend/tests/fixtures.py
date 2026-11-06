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


def _bold(doc, text: str):
    p = doc.add_paragraph()
    p.add_run(text).bold = True
    return p


def make_cases_docx(path: Path) -> Path:
    """Casos resolvidos como nas aulas práticas: tudo em estilo normal, estrutura pelo negrito,
    pela numeração e por marcas de texto ("I", "Quid iuris?", "Resposta completa:")."""
    import docx

    doc = docx.Document()
    doc.add_paragraph("Aulas TP")
    _bold(doc, "I")
    doc.add_paragraph("Alberto celebrou um contrato denominado de avença com Carlos para serviços jurídicos.")
    doc.add_paragraph("Imagine que Alberto alegava que:")
    doc.add_paragraph("- trabalhava obrigatoriamente nas instalações de Carlos;")
    _bold(doc, "Quid iuris?")
    doc.add_paragraph("Temos de qualificar o contrato. Art.º 1152º CC e 11º CT. Presunção do art.º 12º CT.")
    _bold(doc, "Resposta completa:")
    doc.add_paragraph("No presente caso, A sustenta a ilicitude do despedimento. "
                      "Preenchem-se as alíneas a) e b) do art.º 12º/1 CT, pelo que se presume o contrato de trabalho.")
    _bold(doc, "II")
    doc.add_paragraph("Glória foi contratada a termo por 6 meses para substituir Henrique.")
    doc.add_paragraph("Qual foi a duração do período experimental de Glória?", style="List Number")
    doc.add_paragraph("O período experimental é de 30 dias, nos termos do art.º 112º/2/a).")
    doc.add_paragraph("Suponha que o contrato não foi reduzido a escrito. Quid iuris?", style="List Number")
    doc.add_paragraph("Os contratos a termo estão sujeitos a forma escrita (art.º 141º CT); "
                      "sem ela consideram-se sem termo (art.º 147º/1/c)).")
    _bold(doc, "1.º exame parcelar — 2023/10/23")
    _bold(doc, "IV – 4 valores")
    doc.add_paragraph("Desenvolva o tema da mobilidade funcional e do poder de direção do empregador.")
    doc.save(path)
    return path


def make_theory_docx(path: Path) -> Path:
    """Respostas-modelo por tema: títulos com estilo de título e a negrito, sem casos."""
    import docx

    doc = docx.Document()
    doc.add_heading("Período experimental", level=1)
    doc.add_paragraph("O período experimental corresponde ao tempo inicial de execução do contrato "
                      "(art.º 111º CT), durante o qual qualquer das partes pode denunciá-lo (art.º 114º/1).")
    _bold(doc, "Teletrabalho")
    doc.add_paragraph("O teletrabalho é a prestação de trabalho em subordinação jurídica fora da empresa.")
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text, table.cell(0, 1).text = "Contrato", "Período experimental"
    table.cell(1, 0).text, table.cell(1, 1).text = "Termo ≥ 6 meses", "30 dias"
    doc.save(path)
    return path
