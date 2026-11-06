"""Extração de documentos Word (.docx) com a função de cada bloco.

Pensado para material de casos práticos (aulas práticas, testes resolvidos, respostas-modelo).
Cada bloco fica marcado com o que é (`meta["tipo"]`):

- `pergunta`  — enunciado do caso + a pergunta concreta (é isto que se compara com um caso novo);
- `resposta`  — a resolução dessa pergunta (`variante`: "resposta", "esquema" ou "completa");
- `enunciado` — enunciado de um caso sem perguntas separadas, ou a parte longa de um enunciado;
- `teoria`    — exposição por temas (secções com título a negrito ou estilo de título).

Os .docx de aulas raramente usam estilos de título: a estrutura está no negrito, na numeração
automática do Word e em marcas de texto. As regras, por ordem:

1. Um parágrafo só com um numeral romano ("I", "II – 5 valores") ou "Caso 2"/"Hipótese 3"
   abre um caso novo.
2. Um título a negrito com "exame", "teste", "frequência" ou "época" abre um grupo (os casos
   seguintes ficam "<grupo> – I", …).
3. Dentro de um caso, uma pergunta é um parágrafo com "?", "Quid iuris", ou que começa por
   "Comente", "Desenvolva", "Faça", "Com base", … (ou por "Suponha"/"Imagine" se estiver numerado
   ou a negrito). Um parágrafo que termina em ":" ("Imagine que A alegava que:") é enunciado.
   Depois de começar a resolução, só um parágrafo numerado ou a negrito abre a pergunta seguinte.
4. "Resposta completa:" (ou "Resolução:", "Esquema:") muda a variante da resposta da pergunta atual.
5. Fora de casos, um título (estilo de título, ou parágrafo curto todo a negrito) abre uma secção de teoria.

Cada bloco guarda os artigos citados (`artigos`, forma canónica) e os temas (`temas`), separados
por "; ", porque o ChromaDB só aceita valores simples nos metadados.

Como o .docx não tem páginas fixas, `page_number` é a ordem do bloco no documento ("Parte N").
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .chunking import Chunk, ParseResult, count_tokens, normalize, split_by_tokens
from .legal_refs import legal_meta

ENUNCIADO_IN_QUESTION_TOKENS = 350   # parte do enunciado repetida em cada bloco `pergunta`
QUESTION_IN_ANSWER_WORDS = 40        # início da pergunta repetido no cabeçalho de cada bloco `resposta`
HEADING_MAX_CHARS = 150
MIN_UNTITLED_TOKENS = 25

_ROMAN = r"(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3})"   # I a XXXIX (grupos de um teste)
_CASE_RE = re.compile(
    rf"^(?:grupo\s+)?({_ROMAN})(?:\s*[.)]?\s*(?:[–—\-:]\s*(.*))?)?$"
    r"|^(?:caso(?:\s+pr[áa]tico)?|hip[óo]tese|quest[ãa]o|grupo)\s*(?:n\.?\s*[ºo°]\s*)?(\d{1,3}|"
    rf"{_ROMAN})\b\s*[.)]?\s*(?:[–—\-:]\s*(.*))?$",
    re.IGNORECASE,
)
_GROUP_RE = re.compile(r"\b(exame|teste|frequ[êe]ncia|[ée]poca|recurso|prova)\b", re.IGNORECASE)
_ANSWER_MARK_RE = re.compile(
    r"^(resposta(?:\s+(completa|modelo|desenvolvida))?|resolu[çc][ãa]o(?:\s+(completa|desenvolvida))?"
    r"|t[óo]picos(?:\s+de\s+(?:resposta|corre[çc][ãa]o))?|esquema(?:\s+de\s+resposta)?|grelha de corre[çc][ãa]o)\s*:?$",
    re.IGNORECASE,
)
_COMMAND_RE = re.compile(
    r"^(comente|desenvolva|fa[çc]a|explique|analise|diga|pronuncie-se|responda|fundamente|justifique|"
    r"com base|caracterize|distinga|qualifique|aprecie|indique|enuncie|discuta|relacione)\b",
    re.IGNORECASE,
)
_HYPOTHESIS_RE = re.compile(r"^(suponha|imagine|independentemente|admita|considere|e se)\b", re.IGNORECASE)
_QUID_RE = re.compile(r"quid\s+i[uv]ris|o que lhe diria|quid juris", re.IGNORECASE)


@dataclass
class _Para:
    text: str
    bold: bool = False
    numbered: bool = False
    indent: int = 0
    heading_level: int = 0       # 1.. se o parágrafo usa um estilo de título do Word


@dataclass
class _Question:
    text: list[str] = field(default_factory=list)
    indent: int = 0
    answers: dict[str, list[str]] = field(default_factory=dict)   # variante -> parágrafos


@dataclass
class _Case:
    number: str
    group: str = ""
    points: str = ""             # "4 valores"
    enunciado: list[str] = field(default_factory=list)
    questions: list[_Question] = field(default_factory=list)

    @property
    def case_id(self) -> str:
        return f"{_slug(self.group)}/{self.number}" if self.group else self.number

    @property
    def label(self) -> str:
        return f"{self.group} – {self.number}" if self.group else f"Caso {self.number}"


@dataclass
class _Section:
    title: str
    paras: list[str] = field(default_factory=list)


def _slug(text: str) -> str:
    return re.sub(r"[^0-9a-z]+", "-", text.lower()).strip("-")[:40]


# ---------- leitura do Word ----------

def _is_bold(paragraph) -> bool:
    runs = [r for r in paragraph.runs if r.text.strip()]
    if not runs:
        return False
    style_bold = bool(paragraph.style is not None and paragraph.style.font.bold)
    return all(r.bold or (r.bold is None and (style_bold or (r.style is not None and r.style.font.bold)))
               for r in runs)


def _has_numbering(element) -> bool:
    """Numeração automática do Word, no próprio parágrafo ou no seu estilo ("List Number")."""
    ppr = getattr(element, "pPr", None)
    return ppr is not None and ppr.numPr is not None


def _heading_level(paragraph) -> int:
    name = (paragraph.style.name if paragraph.style is not None else "") or ""
    m = re.match(r"(?:heading|t[íi]tulo)\s*(\d)", name, re.IGNORECASE)
    if m:
        return int(m.group(1))
    return 1 if name.lower() in {"title", "título", "titulo"} else 0


def _read_paragraphs(path: Path) -> list[_Para]:
    """Parágrafos e tabelas pela ordem do documento (as tabelas viram linhas Markdown)."""
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    try:
        document = docx.Document(str(path))
    except Exception as exc:   # zip que não é um documento Word (.xlsx renomeado, ficheiro truncado…)
        raise ValueError("o ficheiro não é um documento Word (.docx) válido") from exc
    out: list[_Para] = []
    for child in document.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            p = Paragraph(child, document)
            text = " ".join(p.text.split())
            if not text:
                continue
            numbered = _has_numbering(child) or _has_numbering(getattr(p.style, "element", None))
            indent = p.paragraph_format.left_indent or 0
            out.append(_Para(text, _is_bold(p), numbered, int(indent), _heading_level(p)))
        elif tag == "tbl":
            rows = []
            for row in Table(child, document).rows:
                cells = [" ".join(c.text.split()) for c in row.cells]
                if any(cells):
                    rows.append("| " + " | ".join(cells) + " |")
            if rows:
                out.append(_Para("\n".join(rows)))
    return out


# ---------- classificação ----------

def _looks_like_question(p: _Para) -> bool:
    t = p.text
    if t.endswith(":") or t.startswith("|"):
        return False
    return ("?" in t or bool(_QUID_RE.search(t)) or bool(_COMMAND_RE.match(t))
            or ((p.numbered or p.bold) and bool(_HYPOTHESIS_RE.match(t))))


def _is_title(p: _Para) -> bool:
    if p.heading_level:
        return True
    return p.bold and len(p.text) <= HEADING_MAX_CHARS and not p.text.endswith((".", ";", ","))


def _structure(paras: list[_Para]) -> list[_Case | _Section]:
    units: list[_Case | _Section] = []
    group = ""
    case: _Case | None = None
    section: _Section | None = None
    question: _Question | None = None
    variant = "resposta"
    in_question_text = False   # o último parágrafo foi texto da pergunta (para continuações)
    implicit_cases = 0

    def open_case(number: str, points: str = "") -> _Case:
        nonlocal case, section, question, variant, in_question_text
        case = _Case(number=number, group=group, points=points)
        units.append(case)
        section, question, variant, in_question_text = None, None, "resposta", False
        return case

    def open_question(p: _Para) -> None:
        nonlocal question, variant, in_question_text
        question = _Question(text=[p.text], indent=p.indent)
        case.questions.append(question)
        variant, in_question_text = "resposta", True

    for p in paras:
        t = p.text
        marker = _CASE_RE.match(t) if (p.bold or p.heading_level or len(t) <= 40) else None
        if marker and (p.bold or p.heading_level or marker.group(1)):
            number = (marker.group(1) or marker.group(3)).upper()
            open_case(number, (marker.group(2) or marker.group(4) or "").strip())
            continue

        if _is_title(p) and _GROUP_RE.search(t) and not _looks_like_question(p):
            group = t.rstrip(":")
            case, question, in_question_text = None, None, False
            section = None
            continue

        if case is not None:
            mark = _ANSWER_MARK_RE.match(t) if (p.bold or p.heading_level) else None
            if mark:
                if question is None:                      # resolução sem pergunta separada
                    question = _Question()
                    case.questions.append(question)
                variant = "completa" if re.search(r"complet|desenvolvid", t, re.I) else (
                    "esquema" if re.search(r"t[óo]pico|esquema|grelha", t, re.I) else "resposta")
                in_question_text = False
                continue
            answering = question is not None and not in_question_text
            if in_question_text and not p.numbered and p.indent and p.indent == question.indent:
                question.text.append(t)                   # continuação do item numerado da pergunta
                continue
            if _looks_like_question(p) and (not answering or p.numbered or p.bold):
                if in_question_text and not p.numbered:
                    question.text.append(t)               # pergunta em dois parágrafos
                else:
                    open_question(p)
                continue
            if question is None:
                case.enunciado.append(t)
            elif in_question_text and not answering and p.numbered and not _looks_like_question(p):
                question.text.append(t)                   # alíneas de dados dentro da pergunta
            else:
                in_question_text = False
                question.answers.setdefault(variant, []).append(t)
            continue

        # Fora de casos: teoria, ou uma pergunta solta que abre um caso implícito.
        if (p.numbered or p.bold) and ("?" in t or _QUID_RE.search(t)) and not t.endswith(":"):
            implicit_cases += 1
            open_case(str(implicit_cases))
            open_question(p)
            continue
        if _is_title(p):
            section = _Section(title=t.rstrip(":"))
            units.append(section)
            continue
        if section is None:
            section = _Section(title="")
            units.append(section)
        section.paras.append(t)
    return units


# ---------- blocos ----------

def _meta(tipo: str, text: str, **extra) -> dict:
    meta = {"tipo": tipo, **{k: v for k, v in extra.items() if v not in (None, "")}}
    meta.update(legal_meta(text))
    return meta


def _trim(text: str, max_tokens: int) -> str:
    if count_tokens(text) <= max_tokens:
        return text
    words = text.split()
    return " ".join(words[: int(max_tokens / 1.3)]) + " […]"


def _case_chunks(case: _Case, max_tokens: int, overlap: float, warnings: list[str]) -> list[Chunk]:
    out: list[Chunk] = []
    enunciado = "\n".join(case.enunciado)
    base = {"caso_id": case.case_id, "cotacao": case.points}

    long_enunciado = count_tokens(enunciado) > ENUNCIADO_IN_QUESTION_TOKENS
    if enunciado and (long_enunciado or not case.questions):
        for part in split_by_tokens(enunciado, max_tokens, overlap):
            text = f"{case.label} – enunciado\n{part}"
            out.append(Chunk(text, 0, f"{case.label} · enunciado", meta=_meta("enunciado", text, **base)))

    for qi, q in enumerate(case.questions, 1):
        pid = f"{case.case_id}.{qi}"
        q_text = "\n".join(q.text)
        where = f"{case.label} · pergunta {qi}" if len(case.questions) > 1 or q_text else case.label
        if q_text:
            parts = [f"{case.label} – pergunta {qi}"]
            if enunciado:
                parts.append(f"Enunciado: {_trim(enunciado, ENUNCIADO_IN_QUESTION_TOKENS)}")
            parts.append(f"Pergunta: {q_text}")
            text = "\n".join(parts)
            out.append(Chunk(text, 0, where, meta=_meta("pergunta", text, pergunta_id=pid, **base)))
        if not q.answers:
            warnings.append(f"{where}: pergunta sem resolução no documento.")
        # Com duas versões (tópicos e "Resposta completa"), a primeira é o esquema.
        variants: dict[str, list[str]] = {}
        for name, paras in q.answers.items():   # mantém a ordem do documento
            if name == "resposta" and len(q.answers) > 1:
                name = "esquema"
            variants.setdefault(name, []).extend(paras)
        q_head = " ".join(q_text.split()[:QUESTION_IN_ANSWER_WORDS])
        if q_head and len(q_text.split()) > QUESTION_IN_ANSWER_WORDS:
            q_head += " […]"
        for name, paras in variants.items():
            body = "\n".join(paras)
            label = "resolução" if name == "resposta" else f"resolução ({name})"
            header = f"{case.label} – pergunta {qi} – {label}" + (f"\nPergunta: {q_head}" if q_head else "")
            for part in split_by_tokens(body, max_tokens, overlap):
                text = f"{header}\n{part}"
                out.append(Chunk(text, 0, f"{where} · {label}",
                                 meta=_meta("resposta", text, pergunta_id=pid, variante=name, **base)))
    return out


def _section_chunks(section: _Section, max_tokens: int, overlap: float) -> list[Chunk]:
    body = "\n".join(section.paras)
    if not body or (not section.title and count_tokens(body) < MIN_UNTITLED_TOKENS):
        return []   # cabeçalho solto do documento ("Aulas TP / Direito do Trabalho / 1º teste")
    out = []
    for part in split_by_tokens(body, max_tokens, overlap):
        text = f"{section.title}. {part}" if section.title else part
        out.append(Chunk(text, 0, section.title, meta=_meta("teoria", text)))
    return out


def parse_docx(path: str | Path, max_tokens: int = 500, overlap: float = 0.1) -> ParseResult:
    result = ParseResult()
    paras = _read_paragraphs(Path(path))
    for unit in _structure(paras):
        if isinstance(unit, _Case):
            result.chunks += _case_chunks(unit, max_tokens, overlap, result.warnings)
        else:
            result.chunks += _section_chunks(unit, max_tokens, overlap)
    for i, c in enumerate(result.chunks, start=1):
        c.text = normalize(c.text)
        c.page_number = i
    return result


def summarize_structure(result: ParseResult) -> dict:
    """Contagens por tipo (para o CLI e para os testes)."""
    counts: dict[str, int] = {}
    cases, questions = set(), set()
    for c in result.chunks:
        counts[c.meta.get("tipo", "?")] = counts.get(c.meta.get("tipo", "?"), 0) + 1
        if c.meta.get("caso_id"):
            cases.add(c.meta["caso_id"])
        if c.meta.get("pergunta_id"):
            questions.add(c.meta["pergunta_id"])
    return {"blocos": len(result.chunks), "por_tipo": counts, "casos": len(cases), "perguntas": len(questions)}
