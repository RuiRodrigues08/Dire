import asyncio
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.prompts import REFUSAL
from app.main import run_maintenance

from .conftest import ANSWER, CODES, FakeLLM, login, read_ndjson
from .fixtures import make_pdf, make_pptx

CF = {"Cf-Connecting-Ip": "203.0.113.9", "Cf-Ray": "abc"}


def new_conv_with_pdf(client, tmp_path, name="ml.pdf"):
    conv = client.post("/api/conversations", json={}).json()
    pdf = make_pdf(tmp_path / name)
    r = client.post(f"/api/conversations/{conv['id']}/documents",
                    files={"file": (name, pdf.read_bytes(), "application/pdf")})
    assert r.status_code == 201, r.text
    return conv, r.json()


def ask(client, cid, query, **kw):
    r = client.post(f"/api/conversations/{cid}/chat", json={"query": query, **kw})
    return r, (read_ndjson(r) if r.status_code == 200 else None)


def answer_text(events):
    return "".join(e["data"] for e in events if e["type"] == "token")


# ---------- login ----------

def test_login_logout_and_session(app_ctx):
    state, _, client = app_ctx
    assert client.get("/api/conversations").status_code == 401
    r = login(client, "rui")
    assert r.json()["profile"] == "rui" and r.json()["remote"] is False
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert client.get("/api/session").json()["display_name"] == "Rui"
    client.post("/api/auth/logout")
    assert client.get("/api/conversations").status_code == 401


def test_bruteforce_lockout_after_5_failures(app_ctx):  # critério 7
    _, _, client = app_ctx
    codes = [client.post("/api/auth/login", json={"code": f"errado{i}"}).status_code for i in range(5)]
    assert codes == [401, 401, 401, 401, 429]
    r = client.post("/api/auth/login", json={"code": CODES["rui"]})
    assert r.status_code == 429  # até o código certo fica bloqueado
    # outro IP (via Cloudflare) não é afetado pelo bloqueio local
    state = app_ctx[0]
    state.share.start(120)
    assert client.post("/api/auth/login", json={"code": CODES["rui"]}, headers=CF).status_code == 200


# ---------- isolamento (critério 1) ----------

def test_profiles_are_isolated(make_app, tmp_path):
    state, _, public, _ = make_app()
    with TestClient(public) as rui, TestClient(public) as ana:
        login(rui, "rui")
        login(ana, "namorada")
        conv, doc = new_conv_with_pdf(rui, tmp_path)
        cid = conv["id"]
        assert ana.get("/api/conversations").json() == []
        assert ana.get(f"/api/conversations/{cid}/messages").status_code == 404
        assert ana.get(f"/api/conversations/{cid}/documents").status_code == 404
        assert ana.patch(f"/api/conversations/{cid}", json={"title": "x"}).status_code == 404
        assert ana.delete(f"/api/conversations/{cid}/documents/{doc['doc_id']}").status_code == 404
        assert ana.post(f"/api/conversations/{cid}/chat", json={"query": "overfitting"}).status_code == 404
        assert ana.delete(f"/api/conversations/{cid}").status_code == 404
        # mesmo com uma conversa própria, os vetores do Rui não aparecem
        own = ana.post("/api/conversations", json={}).json()
        _, events = ask(ana, own["id"], "O que é overfitting?")
        assert answer_text(events) == REFUSAL
        # o Rui continua com tudo
        assert len(rui.get(f"/api/conversations/{cid}/documents").json()) == 1
        assert state.workspace("namorada").vectors.count() == 0


# ---------- apagar em cascata (critério 2) ----------

def test_delete_conversation_leaves_nothing(app_ctx, tmp_path):
    state, _, client = app_ctx
    login(client, "rui")
    conv, _ = new_conv_with_pdf(client, tmp_path)
    cid = conv["id"]
    ask(client, cid, "O que é overfitting?")
    ws = state.workspace("rui")
    assert ws.vectors.count(conversation_id=cid) == 3
    assert ws.conversation_dir(cid).is_dir()

    assert client.delete(f"/api/conversations/{cid}").json() == {"ok": True}
    assert ws.vectors.count(conversation_id=cid) == 0
    assert not ws.conversation_dir(cid).exists()
    db = sqlite3.connect(ws.db_path)
    for table in ("conversations", "documents", "messages"):
        col = "id" if table == "conversations" else "conversation_id"
        assert db.execute(f"SELECT COUNT(*) FROM {table} WHERE {col}=?", (cid,)).fetchone()[0] == 0
    from app.services.conversations import reconcile
    assert reconcile(ws) == {"orphan_vectors": [], "removed_paths": []}


def test_delete_single_document_and_reconcile_orphans(app_ctx, tmp_path):
    state, _, client = app_ctx
    login(client, "rui")
    conv, doc = new_conv_with_pdf(client, tmp_path)
    ws = state.workspace("rui")
    assert client.delete(f"/api/conversations/{conv['id']}/documents/{doc['doc_id']}").status_code == 200
    assert ws.vectors.count() == 0
    assert list(ws.conversation_dir(conv["id"]).iterdir()) == []

    # órfãos criados "à mão" (ex.: crash a meio) são limpos no arranque
    ws.vectors.add(ids=["ghost:0"], embeddings=[[0.1] * 512], documents=["x"],
                   metadatas=[{"doc_id": "ghost", "conversation_id": conv["id"]}])
    (ws.uploads_dir / "conversa-inexistente").mkdir(parents=True)
    run_maintenance(state)
    assert ws.vectors.count() == 0
    assert not (ws.uploads_dir / "conversa-inexistente").exists()


# ---------- limpeza automática (critério 3) ----------

def test_cleanup_61_days_respects_pinned(app_ctx, tmp_path):
    state, _, client = app_ctx
    login(client, "rui")
    old, _ = new_conv_with_pdf(client, tmp_path)
    pinned = client.post("/api/conversations", json={"title": "fixada"}).json()
    recent = client.post("/api/conversations", json={}).json()
    client.patch(f"/api/conversations/{pinned['id']}", json={"pinned": True})
    ws = state.workspace("rui")
    ts = (datetime.now(timezone.utc) - timedelta(days=61)).isoformat(timespec="seconds")
    db = sqlite3.connect(ws.db_path)
    db.execute("UPDATE conversations SET last_activity_at=? WHERE id IN (?,?)", (ts, old["id"], pinned["id"]))
    db.commit()
    listed = {c["id"]: c for c in client.get("/api/conversations").json()}
    assert listed[old["id"]]["days_until_deletion"] == 0
    assert listed[pinned["id"]]["days_until_deletion"] is None
    assert listed[recent["id"]]["days_until_deletion"] in (59, 60)

    run_maintenance(state)  # o mesmo que corre no arranque
    ids = {c["id"] for c in client.get("/api/conversations").json()}
    assert ids == {pinned["id"], recent["id"]}
    assert ws.vectors.count(conversation_id=old["id"]) == 0
    assert not ws.conversation_dir(old["id"]).exists()


# ---------- recusa, citações, histórico (critérios 4, 5, 6) ----------

def test_out_of_document_question_refuses_without_llm(app_ctx, tmp_path):
    _, llm, client = app_ctx
    login(client, "rui")
    conv, _ = new_conv_with_pdf(client, tmp_path)
    _, events = ask(client, conv["id"], "Qual é a capital de França?")
    assert answer_text(events) == REFUSAL
    assert llm.stream_calls == []
    sources = next(e for e in events if e["type"] == "sources")
    assert sources["data"] == []
    assert events[-1]["type"] == "done"


def test_overview_question_uses_document_outline(app_ctx, tmp_path):
    _, llm, client = app_ctx
    login(client, "rui")
    conv, _ = new_conv_with_pdf(client, tmp_path)
    _, events = ask(client, conv["id"], "Quais são os temas abordados?")
    assert len(llm.stream_calls) == 1  # não recusa sem chamar o LLM
    context = llm.stream_calls[0][-1]["content"]
    for title in ("Introdução à Aprendizagem Automática", "Overfitting", "Como evitar o overfitting"):
        assert title in context
    sources = next(e for e in events if e["type"] == "sources")["data"]
    whole = [s for s in sources if s["score"] is None]
    assert len(whole) == 1 and whole[0]["source"] == "ml.pdf" and whole[0]["page_number"] == 1


def test_generic_summary_asks_topic_then_summarizes_choice(app_ctx, tmp_path):
    from app.services.rag_engine import TOPIC_MENU_INTRO

    _, llm, client = app_ctx
    login(client, "rui")
    conv, _ = new_conv_with_pdf(client, tmp_path)
    _, events = ask(client, conv["id"], "Faz um resumo da matéria")
    menu = answer_text(events)
    assert menu.startswith(TOPIC_MENU_INTRO)
    assert "2. Overfitting" in menu and "3. Como evitar o overfitting" in menu
    assert llm.stream_calls == [] and llm.rewrite_calls == []

    _, events = ask(client, conv["id"], "3")
    assert len(llm.stream_calls) == 1
    context = llm.stream_calls[0][-1]["content"]
    assert "regularização L2" in context and "memoriza o ruído" not in context
    sources = next(e for e in events if e["type"] == "sources")["data"]
    assert [s["section_title"] for s in sources] == ["Como evitar o overfitting"]


def test_answer_with_sources_and_followup_rewrite(app_ctx, tmp_path):
    _, llm, client = app_ctx
    login(client, "rui")
    conv, _ = new_conv_with_pdf(client, tmp_path)
    cid = conv["id"]

    _, ev1 = ask(client, cid, "O que é overfitting?")
    assert answer_text(ev1).strip() == ANSWER
    src = next(e for e in ev1 if e["type"] == "sources")["data"]
    assert src[0]["source"] == "ml.pdf" and src[0]["page_number"] == 2
    assert {"excerpt", "section_title", "score"} <= set(src[0])
    assert llm.rewrite_calls == []  # sem histórico, sem reescrita
    assert "[ml.pdf, Pág. 2]" in llm.stream_calls[0][1]["content"]
    assert "Com base nos documentos fornecidos" in llm.stream_calls[0][0]["content"]

    # Sem reescrita, "E como se evita?" não passa o threshold; reescrita, recupera a pág. 3.
    _, ev2 = ask(client, cid, "E como se evita?")
    assert len(llm.rewrite_calls) == 1
    assert "O que é overfitting?" in llm.rewrite_calls[0]
    assert next(e for e in ev2 if e["type"] == "rewrite")["data"] == "Como se evita o overfitting?"
    src2 = next(e for e in ev2 if e["type"] == "sources")["data"]
    assert src2[0]["page_number"] == 3
    gen_prompt = llm.stream_calls[1][1]["content"]
    assert "PERGUNTA:\nComo se evita o overfitting?" in gen_prompt
    # critério 6: a resposta anterior nunca entra no CONTEXTO FORNECIDO
    assert ANSWER not in gen_prompt and "regularização e dropout [" not in gen_prompt

    done = ev2[-1]
    assert done["type"] == "done"
    assert done["usage"] == {"prompt_tokens": 240, "gen_tokens": 28}  # reescrita + geração

    msgs = client.get(f"/api/conversations/{cid}/messages").json()
    assert [m["role"] for m in msgs] == ["user", "assistant"] * 2
    assert msgs[3]["sources"][0]["page_number"] == 3 and msgs[3]["prompt_tokens"] == 240
    conv_now = next(c for c in client.get("/api/conversations").json() if c["id"] == cid)
    assert conv_now["title"] == "O que é overfitting?"


def test_doc_ids_filter_and_pptx_citation(app_ctx, tmp_path):
    _, llm, client = app_ctx
    login(client, "rui")
    conv, pdf_doc = new_conv_with_pdf(client, tmp_path)
    pptx = make_pptx(tmp_path / "nn.pptx")
    r = client.post(f"/api/conversations/{conv['id']}/documents",
                    files={"file": ("nn.pptx", pptx.read_bytes(), "application/octet-stream")})
    body = r.json()
    assert body["n_chunks"] == 2 and body["skipped"] == [3] and body["warnings"]
    _, ev = ask(client, conv["id"], "Que taxa típica usa o otimizador Adam?", doc_ids=[body["doc_id"]])
    src = next(e for e in ev if e["type"] == "sources")["data"]
    assert src and all(s["source"] == "nn.pptx" for s in src)
    assert "[nn.pptx, Slide 2]" in llm.stream_calls[-1][1]["content"]
    r, _ = ask(client, conv["id"], "x", doc_ids=["nao-existe"])
    assert r.status_code == 400


# ---------- uploads ----------

def test_upload_validation(app_ctx, tmp_path, monkeypatch):
    state, _, client = app_ctx
    login(client, "rui")
    cid = client.post("/api/conversations", json={}).json()["id"]
    url = f"/api/conversations/{cid}/documents"
    assert client.post(url, files={"file": ("a.txt", b"ola", "text/plain")}).status_code == 415
    assert client.post(url, files={"file": ("a.pdf", b"not a pdf", "application/pdf")}).status_code == 415
    pdf = make_pdf(tmp_path / "ml.pdf").read_bytes()
    first = client.post(url, files={"file": ("ml.pdf", pdf, "application/pdf")}).json()
    dup = client.post(url, files={"file": ("copia.pdf", pdf, "application/pdf")}).json()
    assert dup["duplicate"] is True and dup["doc_id"] == first["doc_id"]
    for i in range(4):
        other = make_pdf(tmp_path / f"o{i}.pdf", filler_paragraphs=i + 1)
        assert client.post(url, files={"file": (f"o{i}.pdf", other.read_bytes(), "application/pdf")}).status_code == 201
    extra = make_pdf(tmp_path / "x.pdf", filler_paragraphs=9).read_bytes()
    assert client.post(url, files={"file": ("x.pdf", extra, "application/pdf")}).status_code == 409
    state.settings.max_file_mb = 0
    assert client.post(url, files={"file": ("y.pdf", extra, "application/pdf")}).status_code == 413


def test_failed_indexing_leaves_no_vectors_or_file(make_app, tmp_path):
    from app.services.embeddings import HashEmbedder

    class Broken(HashEmbedder):
        def embed_documents(self, texts):
            raise RuntimeError("falha simulada")

    state, _, public, _ = make_app(embedder=Broken())
    with TestClient(public, raise_server_exceptions=False) as client:
        login(client, "rui")
        cid = client.post("/api/conversations", json={}).json()["id"]
        pdf = make_pdf(tmp_path / "ml.pdf").read_bytes()
        r = client.post(f"/api/conversations/{cid}/documents", files={"file": ("ml.pdf", pdf, "application/pdf")})
        assert r.status_code == 500
        ws = state.workspace("rui")
        assert ws.vectors.count() == 0
        assert list(ws.conversation_dir(cid).iterdir()) == []
        assert client.get(f"/api/conversations/{cid}/documents").json() == []


# ---------- fila (critério 11) ----------

def test_concurrent_requests_queue_with_position(make_app, tmp_path):
    state, llm, public, _ = make_app(llm=FakeLLM(delay=0.02))
    with TestClient(public) as client:
        login(client, "rui")
        conv, _ = new_conv_with_pdf(client, tmp_path)
        cookies = dict(client.cookies)

    async def run():
        transport = httpx.ASGITransport(app=public)
        async with httpx.AsyncClient(transport=transport, base_url="http://t", cookies=cookies) as ac:
            url = f"/api/conversations/{conv['id']}/chat"
            return await asyncio.gather(*[ac.post(url, json={"query": "O que é overfitting?"}) for _ in range(3)])

    responses = asyncio.run(run())
    positions = sorted(
        max((e["position"] for e in read_ndjson(r) if e["type"] == "queue"), default=0) for r in responses
    )
    assert positions == [0, 1, 2]
    assert all(read_ndjson(r)[-1]["type"] == "done" for r in responses)
    assert state.queue.size == 0


# ---------- sessões remotas e limites do link (critérios 8 e 9, parte da API) ----------

@pytest.fixture
def https_ctx(make_app):
    # O túnel serve HTTPS ao browser; o cookie remoto é `Secure`.
    state, llm, public, _ = make_app()
    with TestClient(public, base_url="https://testserver") as client:
        yield state, llm, client


def test_remote_sessions_limits_and_expiry(https_ctx, tmp_path):
    state, _, client = https_ctx
    login(client, "rui")
    conv, _ = new_conv_with_pdf(client, tmp_path)
    cid = conv["id"]
    client.cookies.clear()

    assert client.post("/api/auth/login", json={"code": CODES["rui"]}, headers=CF).status_code == 403
    state.share.start(120, max_questions=2)
    r = login(client, "rui", headers=CF)
    assert r.json()["remote"] is True and r.json()["questions_left"] == 2
    assert "secure" in r.headers["set-cookie"].lower()

    for left in (1, 0):
        resp = client.post(f"/api/conversations/{cid}/chat", json={"query": "O que é overfitting?"}, headers=CF)
        assert read_ndjson(resp)[-1]["questions_left"] == left
    blocked = client.post(f"/api/conversations/{cid}/chat", json={"query": "O que é overfitting?"}, headers=CF)
    assert blocked.status_code == 429 and blocked.json()["code"] == "limit_reached"

    state.share.stop()  # link expira/pára
    assert client.get("/api/session", headers=CF).status_code == 401
    # o histórico mantém-se para uso local
    client.cookies.clear()
    login(client, "rui")
    assert len(client.get(f"/api/conversations/{cid}/messages").json()) == 4


def test_local_cookie_rejected_through_tunnel_and_token_limit(https_ctx, tmp_path):
    state, _, client = https_ctx
    login(client, "rui")
    conv, _ = new_conv_with_pdf(client, tmp_path)
    assert client.get("/api/session", headers=CF).status_code == 401
    state.share.start(120, max_tokens=150)
    client.cookies.clear()
    login(client, "rui", headers=CF)
    ok = client.post(f"/api/conversations/{conv['id']}/chat", json={"query": "O que é overfitting?"}, headers=CF)
    assert read_ndjson(ok)[-1]["tokens_left"] == 0  # 220 > 150: esgota
    again = client.post(f"/api/conversations/{conv['id']}/chat", json={"query": "O que é overfitting?"}, headers=CF)
    assert again.status_code == 429 and "tokens" in again.json()["message"]


# ---------- definições (critérios 12 e 13, parte da API) ----------

def test_settings_per_profile_and_validation(make_app):
    _, _, public, _ = make_app()
    with TestClient(public) as rui, TestClient(public) as ana:
        login(rui, "rui")
        login(ana, "namorada")
        assert rui.get("/api/settings").json()["theme"] == "system"
        r = rui.put("/api/settings", json={"theme": "dark", "accent": "#ffcc00", "show_tokens": True})
        assert r.status_code == 200 and r.json()["accent"] == "#FFCC00" and r.json()["accent_text"] == "#000000"
        assert rui.get("/api/settings").json()["theme"] == "dark"
        assert ana.get("/api/settings").json()["theme"] == "system"
        for bad in ({"accent": "red; background:url(x)"}, {"css": "body{}"}, {"theme": "neon"},
                    {"show_tokens": "yes"}, ["theme"]):
            assert rui.put("/api/settings", json=bad).status_code == 400
        assert rui.delete("/api/settings").json()["theme"] == "system"


def test_csrf_content_type_and_security_headers(app_ctx):
    _, _, client = app_ctx
    r = client.post("/api/auth/login", content=b"code=x", headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert r.status_code == 415
    login(client, "rui")
    r = client.get("/api/conversations")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert client.get("/docs").status_code == 404 and client.get("/openapi.json").status_code == 404


def test_admin_app_rejects_tunnel_requests(make_app):
    state, _, _, admin = make_app()
    with TestClient(admin) as c:
        assert c.get("/admin/share/status").json()["state"] == "inativo"
        assert c.get("/admin/share/status", headers=CF).status_code == 403


def test_export_markdown(app_ctx, tmp_path):
    _, _, client = app_ctx
    login(client, "rui")
    conv, _ = new_conv_with_pdf(client, tmp_path)
    ask(client, conv["id"], "O que é overfitting?")
    md = client.get(f"/api/conversations/{conv['id']}/export").text
    assert "**Pergunta:**" in md and "- ml.pdf, Pág. 2" in md
