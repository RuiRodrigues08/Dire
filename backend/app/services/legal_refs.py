"""Referências jurídicas: artigos citados e temas de Direito do Trabalho.

- `extract_articles` encontra citações como "art.º 12º CT", "artigo 3º nº4 do CT",
  "art.º 1152º e 1153º CC" ou "art.º 112º/2/a)" e devolve-as numa forma canónica
  ("art. 112.º/2/a) CT"), para guardar nos metadados e comparar com a resposta esperada.
- `TOPICS` é a lista fechada de temas (tirada dos títulos das respostas-modelo da cadeira);
  `tag_topics` marca um texto com os temas que menciona (palavras-chave + artigos do CT).

São heurísticas simples e determinísticas: servem para filtrar e medir, não para decidir
sozinhas a resolução de um caso.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# ---------- artigos ----------

_DIPLOMAS = r"CT|CC|CRP|CPT|CPC|CP|LCT"
# Um número de artigo: "12", "12º", "12.º", "1152.º", seguido de subdivisões "/2/a)" ou "nº 4", "n.º4".
_NUM = r"\d{1,4}(?:\s*\.?\s*[ºo°])?(?:-[A-Z]\b)?"
# "/2", "/a)" (alínea: letra com parêntese), "nº 4", "al. b)". Um ")" depois de um número é
# o fecho de um parêntese do texto ("(art.º 140º/1/2)") e não faz parte da citação.
_SUB = r"(?:\s*/\s*(?:[a-z]\)|\d{1,3}|[a-z]{1,2}\b)|\s*,?\s*n\.?\s*[ºo°]\s*\d{1,3}|\s*,?\s*al(?:ínea|\.)\s*[a-z]\))*"
_ART_RE = re.compile(
    rf"\b(?:art(?:igo)?s?|arts)\s*\.?\s*[ºo°]?\s*\.?\s*"           # art. / art.º / artigo / artigos / arts.
    rf"((?:{_NUM}{_SUB})(?:\s*(?:,|e|a|ou)\s*(?:{_NUM}{_SUB}))*)"  # 1152º e 1153º / 53º a 59º
    rf"(?:\s*(?:e\s+)?(?:ss|segs?|seguintes)\b\.?)?"                # 139º ss.
    rf"(?:\s*,?\s*(?:do|da|no|na|dos|das)?\s*({_DIPLOMAS})\b)?",
    re.IGNORECASE,
)
_ONE_RE = re.compile(rf"(\d{{1,4}})(?:\s*\.?\s*[ºo°])?(-[A-Z]\b)?({_SUB})", re.IGNORECASE)
# Depois de "… CC", outra lista de números com o seu diploma: "art.º 1152º CC e 11º CT".
_CONT_RE = re.compile(
    rf"\s*(?:,|e|;)\s*((?:{_NUM}{_SUB})(?:\s*(?:,|e|a|ou)\s*(?:{_NUM}{_SUB}))*)\s*,?\s*(?:do|da|no|na)?\s*({_DIPLOMAS})\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Article:
    number: str          # "12", "166-A"
    sub: str             # "/2/a)" ou ""
    diploma: str         # "CT", "CC", "CRP", …
    inferred: bool       # True se o diploma não estava escrito e foi deduzido

    @property
    def base(self) -> str:
        """Artigo sem subdivisões: "12 CT". É o que se compara na avaliação."""
        return f"{self.number} {self.diploma}"

    def __str__(self) -> str:
        num, _, suffix = self.number.partition("-")
        return f"art. {num}.º{'-' + suffix if suffix else ''}{self.sub} {self.diploma}"


def _clean_sub(sub: str) -> str:
    parts = re.findall(r"n\.?\s*[ºo°]\s*(\d{1,3})|al(?:ínea|\.)\s*([a-z]\))|/\s*([0-9a-z]{1,3}\)?)", sub, re.I)
    out = [next(p for p in g if p) for g in parts]
    return "".join(f"/{p}" for p in out)


def _infer_diploma(number: str) -> str:
    """Sem diploma escrito: num texto de Direito do Trabalho, um número até 566 é do CT
    (o CT de 2009 tem 566 artigos) e um número maior é do Código Civil."""
    n = int(re.match(r"\d+", number).group())
    return "CT" if n <= 566 else "CC"


def extract_articles(text: str) -> list[Article]:
    """Artigos citados, pela ordem e sem repetições (mesmo número, subdivisão e diploma)."""
    seen: dict[tuple, Article] = {}

    def add(nums: str, diploma: str | None) -> None:
        for one in _ONE_RE.finditer(nums):
            number = one.group(1) + (one.group(2) or "").upper()
            sub = _clean_sub(one.group(3) or "")
            dip = diploma.upper() if diploma else _infer_diploma(number)
            art = Article(number, sub, dip, inferred=not diploma)
            seen.setdefault((art.number, art.sub, art.diploma), art)

    for m in _ART_RE.finditer(text):
        add(m.group(1), m.group(2))
        end = m.end()
        while m.group(2) and (c := _CONT_RE.match(text, end)):
            add(c.group(1), c.group(2))
            end = c.end()
    return list(seen.values())


def article_bases(text: str) -> list[str]:
    """Só os artigos base ("12 CT"), sem repetições, pela ordem."""
    return list(dict.fromkeys(a.base for a in extract_articles(text)))


# ---------- temas ----------

@dataclass(frozen=True)
class Topic:
    id: str
    label: str
    keywords: tuple[str, ...]                 # expressões regulares sobre texto sem acentos, minúsculas
    ct_articles: tuple[tuple[int, int], ...]  # intervalos de artigos do CT que indicam o tema


TOPICS: tuple[Topic, ...] = (
    Topic("funcao_tuitiva", "Função tuitiva do Direito do Trabalho",
          (r"funcao tuitiva", r"parte mais debil", r"contraente debil"), ()),
    Topic("fontes_art3", "Fontes e relações entre fontes (art. 3.º CT, tratamento mais favorável)",
          (r"tratamento mais favoravel", r"relac\w* entre (as )?fontes", r"\birct", r"convenc\w* coletiv",
           r"fontes (especificas|do direito do trabalho)"), ((1, 3),)),
    Topic("qualificacao", "Qualificação do contrato (trabalho vs. prestação de serviço, presunção do art. 12.º)",
          (r"prestac\w* de servic", r"presunc\w* de (laboralidade|existencia do contrato)", r"subordinac\w* juridic",
           r"metodo indiciario", r"qualificac\w* (juridic\w* )?(do |de um )?contrat", r"\bavenca\b",
           r"primazia da realidade", r"qualificad\w* como contrato", r"natureza laboral", r"nomen iuris",
           r"caracteriza\w*(-se)? (este|o|esse) contrato como contrato de trabalho"), ((11, 12),)),
    Topic("dever_informacao", "Dever de informação do empregador",
          (r"dever(es)? de informac", r"nao informou"), ((106, 109),)),
    Topic("promessa", "Promessa de contrato de trabalho",
          (r"promessa de contrato",), ((103, 103),)),
    Topic("periodo_experimental", "Período experimental",
          (r"periodo experimental",), ((111, 114),)),
    Topic("mobilidade_funcional", "Objeto da prestação, polivalência e mobilidade funcional",
          (r"mobilidade funcional", r"polivalencia", r"objeto da prestac", r"determinac\w* da atividade",
           r"categoria", r"funcoes afins", r"ius variandi", r"clausulas? de mobilidade", r"outras funcoes",
           r"recusar\w*(-se)? a cumprir a ordem"), ((115, 120),)),
    Topic("limitacao_liberdade", "Cláusulas de limitação da liberdade de trabalho",
          (r"nao concorrencia", r"pacto de permanencia", r"limitac\w* da liberdade de trabalho"), ((136, 138),)),
    Topic("termo_certo", "Contrato a termo certo (requisitos materiais e formais)",
          (r"termo certo", r"termo resolutivo", r"necessidade(s)? temporaria", r"contrato(s)?( de trabalho)? a termo"),
          ((139, 147),)),
    Topic("renovacao_caducidade", "Renovação, duração e caducidade do contrato a termo",
          (r"renovac", r"caducidade", r"compensac\w* por caducidade", r"verificac\w* do termo"),
          ((148, 149), (344, 345))),
    Topic("termo_incerto", "Contrato a termo incerto", (r"termo incerto",), ()),
    Topic("tempo_parcial", "Trabalho a tempo parcial", (r"tempo parcial",), ((150, 156),)),
    Topic("intermitente", "Trabalho intermitente", (r"intermitente",), ((157, 160),)),
    Topic("comissao_servico", "Comissão de serviço", (r"comissao de servico",), ((161, 164),)),
    Topic("teletrabalho", "Teletrabalho", (r"teletrabalho", r"telesubordinac"), ((165, 171),)),
    Topic("trabalho_temporario", "Trabalho temporário", (r"trabalho temporario", r"empresa de trabalho temporario"),
          ((172, 192),)),
    Topic("denuncia_trabalhador", "Cessação por iniciativa do trabalhador (denúncia, aviso prévio)",
          (r"desvincular", r"denuncia\w* (do contrato )?(pelo|por parte do) trabalhador", r"aviso[- ]previo"),
          ((400, 403),)),
    Topic("despedimento", "Despedimento e ilicitude", (r"despedimento",), ((338, 343), (351, 393))),
)
TOPIC_IDS = tuple(t.id for t in TOPICS)
_TOPIC_BY_ID = {t.id: t for t in TOPICS}
_COMPILED = {t.id: [re.compile(k) for k in t.keywords] for t in TOPICS}


def topic_label(topic_id: str) -> str:
    return _TOPIC_BY_ID[topic_id].label


def fold(text: str) -> str:
    """Minúsculas e sem acentos, para comparar palavras-chave."""
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(ch for ch in text if not unicodedata.combining(ch))


def tag_topics(text: str, articles: list[Article] | None = None) -> list[str]:
    """Temas mencionados no texto, pela ordem de `TOPICS`."""
    folded = fold(text)
    arts = articles if articles is not None else extract_articles(text)
    ct_numbers = {int(re.match(r"\d+", a.number).group()) for a in arts if a.diploma == "CT"}
    out = []
    for t in TOPICS:
        if any(p.search(folded) for p in _COMPILED[t.id]) or any(
            lo <= n <= hi for n in ct_numbers for lo, hi in t.ct_articles
        ):
            out.append(t.id)
    return out


def legal_meta(text: str) -> dict:
    """Metadados `artigos` e `temas` de um bloco (vazios ficam de fora: o ChromaDB guarda só valores simples)."""
    arts = extract_articles(text)
    out = {}
    if arts:
        out["artigos"] = "; ".join(str(a) for a in arts)
    topics = tag_topics(text, arts)
    if topics:
        out["temas"] = "; ".join(topics)
    return out
