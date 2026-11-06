"""Fase 0: o script de avaliação retira as perguntas de teste do corpus e mede pesquisa e resolução."""
import asyncio

from app.core.config import load_settings
from app.services.embeddings import HashEmbedder
from app.services.llm import Usage
from app.tools.eval_cases import report_table, run

from .fixtures import make_cases_docx, make_theory_docx

EVALSET = {
    "excluir_do_corpus": {"caso_id": ["II"], "texto": ["Glória foi contratada"]},
    "itens": [{
        "id": "termo-escrito",
        "enunciado": "Glória foi contratada a termo por 6 meses para substituir Henrique.",
        "pergunta": "Suponha que o contrato não foi reduzido a escrito. Quid iuris?",
        "temas_esperados": ["termo_certo"],
        "artigos_essenciais": ["141 CT", "147 CT"],
        "artigos_aceites": ["140 CT"],
    }],
}


class StubLLM:
    """Análises e resposta-modelo curtas; a resolução cita um artigo certo e um errado."""

    def __init__(self):
        self.prompts = []

    async def complete(self, messages, num_predict, num_ctx=None):
        self.prompts.append(messages[-1]["content"])
        return "## Enquadramento\n## Solução", Usage(10, 5)

    async def stream(self, messages, num_predict, usage, num_ctx=None):
        self.prompts.append(messages[-1]["content"])
        for piece in ("O contrato a termo exige forma escrita (art.º 141º CT), ", "senão é sem termo (art.º 147º CT). ",
                      "Ver ainda o art.º 3º CT."):
            yield piece
        usage += Usage(100, 20)


def test_eval_holds_out_questions_and_scores(env, tmp_path):
    corpus = [make_cases_docx(tmp_path / "aulas.docx"), make_theory_docx(tmp_path / "rm.docx")]
    llm = StubLLM()
    report = asyncio.run(run(EVALSET, corpus, load_settings(), k=6, solve=True, llm=llm,
                             embedder=HashEmbedder(), log=lambda *_: None))
    assert report["blocos_retirados"] == 4                     # caso II: 2 perguntas + 2 resoluções
    item = report["itens"][0]
    assert all("Glória" not in b["local"] for b in item["pesquisa"]["blocos"])
    # A resolução guardada da pergunta de teste nunca chega ao modelo (nem na análise, nem como excerto).
    assert not any("sem ela consideram-se sem termo" in p for p in llm.prompts)
    assert any("CASO NOVO:\nGlória foi contratada" in p for p in llm.prompts)
    a = item["resolucao"]
    assert a["artigos_citados"] == ["141 CT", "147 CT", "3 CT"]
    assert a["artigos_recall"] == 1.0 and a["artigos_precisao"] == round(2 / 3, 3)
    table = report_table(report)
    assert "| termo-escrito |" in table and "**média**" in table
