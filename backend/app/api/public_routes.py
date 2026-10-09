"""API pública (porta 8000): auth, conversas, documentos, bases de dados, chat NDJSON, definições,
imagens do perfil e partilha por link."""
from __future__ import annotations

import asyncio
import json
import math
import logging
import time

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from ..core import user_settings
from ..core.auth import COOKIE_NAME, Session, client_ip, is_remote_request
from ..core.state import AppState
from ..services import conversations as convs
from ..services import documents as docs
from ..services import libraries as libs
from ..services import media
from ..services.export_pdf import conversation_pdf
from ..services.share_manager import ShareError
from ..services.case_tools import MAX_CASE_CHARS, MODEL_ANSWER_LABEL, SOLVE_LABEL
from ..services.rag_engine import AnswerResult
from ..services.workspace import Workspace

log = logging.getLogger("rag.api")
router = APIRouter(prefix="/api")


# ---------- dependências ----------

def get_state(request: Request) -> AppState:
    return request.app.state.rag


def current_session(request: Request, state: AppState = Depends(get_state)) -> Session:
    sess = state.sessions.validate(request.cookies.get(COOKIE_NAME), is_remote_request(request.headers))
    if sess is None:
        raise HTTPException(401, "Sessão inválida ou expirada.")
    return sess


def current_ws(sess: Session = Depends(current_session), state: AppState = Depends(get_state)) -> Workspace:
    # O perfil vem SEMPRE da sessão no servidor, nunca do pedido.
    return state.workspace(sess.profile)


def owned_conversation(conversation_id: str, ws: Workspace = Depends(current_ws)) -> dict:
    conv = convs.get(ws, conversation_id)
    if conv is None:  # inexistente ou de outro perfil: a resposta é a mesma
        raise HTTPException(404, "Conversa não encontrada.")
    return conv


# ---------- auth ----------

class LoginBody(BaseModel):
    code: str = Field(min_length=1, max_length=200)


@router.post("/auth/login")
def login(body: LoginBody, request: Request, response: Response, state: AppState = Depends(get_state)):
    ip = client_ip(request)
    wait = state.limiter.retry_after(ip)
    if wait:
        raise HTTPException(429, f"Demasiadas tentativas. Tenta novamente daqui a {wait // 60 + 1} min.",
                            headers={"Retry-After": str(wait)})
    remote = is_remote_request(request.headers)
    profile = state.registry.verify(body.code)  # verifica sempre todos os hashes
    if profile is None:
        locked = state.limiter.failure(ip)
        if locked:
            raise HTTPException(429, f"Demasiadas tentativas. Tenta novamente daqui a {locked // 60} min.",
                                headers={"Retry-After": str(locked)})
        raise HTTPException(401, "Código inválido.")
    if remote and not state.share.is_active():
        raise HTTPException(403, "A partilha não está ativa.")
    state.limiter.success(ip)
    sess, token = state.sessions.create(profile, remote)
    response.set_cookie(
        COOKIE_NAME, token, httponly=True, samesite="lax",
        secure=remote or request.url.scheme == "https",
        max_age=max(1, int(sess.expires_at - time.time())), path="/",
    )
    return _session_info(state, sess)


@router.post("/auth/logout")
def logout(request: Request, response: Response, state: AppState = Depends(get_state)):
    sess = state.sessions.validate(request.cookies.get(COOKIE_NAME), is_remote_request(request.headers))
    if sess:
        state.sessions.delete(sess.sid)
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


def _session_info(state: AppState, sess: Session) -> dict:
    info = {
        "profile": sess.profile,
        "display_name": state.registry.display_name(sess.profile),
        "is_admin": sess.profile == state.settings.admin_profile,
        "media": media.versions(state.workspace(sess.profile)),
        "remote": sess.remote,
        "expires_at": int(sess.expires_at),
        "questions_left": None,
        "tokens_left": None,
        "share_expires_at": None,
    }
    if sess.remote and state.share.budget:
        b = state.share.budget
        info.update(questions_left=b.questions_left, tokens_left=b.tokens_left,
                    share_expires_at=int(b.expires_at) if math.isfinite(b.expires_at) else None)
    return info


@router.get("/session")
def session_info(sess: Session = Depends(current_session), state: AppState = Depends(get_state)):
    return _session_info(state, sess)


# ---------- conversas ----------

class ConversationCreate(BaseModel):
    title: str | None = Field(default=None, max_length=200)


class ConversationPatch(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    pinned: bool | None = None
    library_id: str | None = None  # null desliga a base; omitido não mexe


@router.get("/conversations")
def list_conversations(ws: Workspace = Depends(current_ws)):
    return convs.list_all(ws)


@router.post("/conversations", status_code=201)
def create_conversation(body: ConversationCreate | None = None, ws: Workspace = Depends(current_ws)):
    return convs.create(ws, body.title if body else None)


@router.patch("/conversations/{conversation_id}")
def patch_conversation(body: ConversationPatch, conv: dict = Depends(owned_conversation),
                       ws: Workspace = Depends(current_ws)):
    extra = {}
    if "library_id" in body.model_fields_set:
        if body.library_id is not None and libs.get(ws, body.library_id) is None:
            raise HTTPException(404, "Base de dados não encontrada.")
        extra["library_id"] = body.library_id
    return convs.update(ws, conv["id"], title=body.title, pinned=body.pinned, **extra)


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conv: dict = Depends(owned_conversation), ws: Workspace = Depends(current_ws)):
    convs.delete(ws, conv["id"])
    return {"ok": True}


@router.delete("/conversations")
def delete_all_conversations(ws: Workspace = Depends(current_ws)):
    return {"deleted": convs.delete_all(ws)}


@router.get("/conversations/{conversation_id}/messages")
def list_messages(conv: dict = Depends(owned_conversation), ws: Workspace = Depends(current_ws)):
    return convs.messages(ws, conv["id"])


def _pick_exchanges(messages: list[dict], ids: str | None) -> list[dict]:
    if not ids:
        return messages
    try:
        wanted = {int(x) for x in ids.split(",") if x.strip()}
    except ValueError:
        raise HTTPException(400, "Lista de mensagens inválida.")
    out, keep = [], False
    for m in messages:
        if m["role"] == "user":
            keep = m["id"] in wanted
        if keep:
            out.append(m)
    return out


@router.get("/conversations/{conversation_id}/export", response_class=Response)
async def export_conversation(ids: str | None = None, conv: dict = Depends(owned_conversation),
                              ws: Workspace = Depends(current_ws)):
    """`ids`: só estas perguntas (ids das mensagens do utilizador, separados por vírgulas), cada uma
    com a sua resposta. Sem `ids`, a conversa inteira."""
    msgs = _pick_exchanges(convs.messages(ws, conv["id"]), ids)
    accent = user_settings.load(ws.db_path)["accent"]
    data = await asyncio.to_thread(conversation_pdf, conv["title"], msgs, accent)
    return Response(data, media_type="application/pdf",
                    headers={"Content-Disposition": 'attachment; filename="conversa.pdf"'})

# ---------- documentos ----------

@router.get("/conversations/{conversation_id}/documents")
def list_documents(conv: dict = Depends(owned_conversation), ws: Workspace = Depends(current_ws)):
    return docs.list_documents(ws, conv["id"])


@router.post("/conversations/{conversation_id}/documents", status_code=201)
async def upload_document(file: UploadFile = File(...), conv: dict = Depends(owned_conversation),
                          ws: Workspace = Depends(current_ws), state: AppState = Depends(get_state)):
    limit = state.settings.max_file_mb * 1024 * 1024
    data = await file.read(limit + 1)
    try:
        return await asyncio.to_thread(docs.ingest, ws, state.embedder, conv["id"], file.filename or "", data)
    except docs.IngestError as e:
        raise HTTPException(e.status, e.message)


@router.delete("/conversations/{conversation_id}/documents/{doc_id}")
def delete_document(doc_id: str, conv: dict = Depends(owned_conversation), ws: Workspace = Depends(current_ws)):
    if not docs.delete_document(ws, conv["id"], doc_id):
        raise HTTPException(404, "Documento não encontrado.")
    return {"ok": True}


# ---------- bases de dados ----------

class LibraryBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)


def owned_library(library_id: str, ws: Workspace = Depends(current_ws)) -> dict:
    lib = libs.get(ws, library_id)
    if lib is None:
        raise HTTPException(404, "Base de dados não encontrada.")
    return lib


@router.get("/libraries")
def list_libraries(ws: Workspace = Depends(current_ws)):
    return libs.list_all(ws)


@router.post("/libraries", status_code=201)
def create_library(body: LibraryBody, ws: Workspace = Depends(current_ws)):
    try:
        return libs.create(ws, body.name)
    except libs.LibraryError as e:
        raise HTTPException(400, str(e))


@router.patch("/libraries/{library_id}")
def rename_library(body: LibraryBody, lib: dict = Depends(owned_library), ws: Workspace = Depends(current_ws)):
    try:
        return libs.rename(ws, lib["id"], body.name)
    except libs.LibraryError as e:
        raise HTTPException(400, str(e))


@router.delete("/libraries/{library_id}")
def delete_library(lib: dict = Depends(owned_library), ws: Workspace = Depends(current_ws)):
    libs.delete(ws, lib["id"])
    return {"ok": True}


@router.get("/libraries/{library_id}/search")
async def search_library(q: str, lib: dict = Depends(owned_library), ws: Workspace = Depends(current_ws),
                         state: AppState = Depends(get_state)):
    q = q.strip()[: state.settings.max_query_chars]
    if len(q) < 2:
        return []
    return await asyncio.to_thread(libs.search, ws, state.embedder, lib["id"], q)


@router.get("/libraries/{library_id}/documents")
def list_library_documents(lib: dict = Depends(owned_library), ws: Workspace = Depends(current_ws)):
    return docs.list_library_documents(ws, lib["id"])


@router.post("/libraries/{library_id}/documents", status_code=201)
async def upload_library_document(file: UploadFile = File(...), lib: dict = Depends(owned_library),
                                  ws: Workspace = Depends(current_ws), state: AppState = Depends(get_state)):
    limit = state.settings.max_file_mb * 1024 * 1024
    data = await file.read(limit + 1)
    try:
        return await asyncio.to_thread(docs.ingest, ws, state.embedder, None, file.filename or "", data, lib["id"])
    except docs.IngestError as e:
        raise HTTPException(e.status, e.message)


@router.delete("/libraries/{library_id}/documents/{doc_id}")
def delete_library_document(doc_id: str, lib: dict = Depends(owned_library), ws: Workspace = Depends(current_ws)):
    if not docs.delete_document(ws, None, doc_id, library_id=lib["id"]):
        raise HTTPException(404, "Documento não encontrado.")
    return {"ok": True}


# ---------- chat ----------

class ChatBody(BaseModel):
    query: str
    doc_ids: list[str] | None = None


def _line(event: dict) -> bytes:
    return (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")


@router.post("/conversations/{conversation_id}/chat")
async def chat(body: ChatBody, conv: dict = Depends(owned_conversation), ws: Workspace = Depends(current_ws),
               sess: Session = Depends(current_session), state: AppState = Depends(get_state)):
    s = state.settings
    query = body.query.strip()
    if not query:
        raise HTTPException(400, "A pergunta está vazia.")
    if len(query) > s.max_query_chars:
        raise HTTPException(400, f"A pergunta excede {s.max_query_chars} caracteres.")
    doc_ids = None
    if body.doc_ids:
        doc_ids = docs.valid_doc_ids(ws, conv["id"], body.doc_ids)
        if len(doc_ids) != len(set(body.doc_ids)):
            raise HTTPException(400, "Documento desconhecido nesta conversa.")
    history = convs.recent_history(ws, conv["id"], s.history_turns)
    result = AnswerResult()
    return _stream(state, sess, ws, conv["id"], query, result,
                   lambda: state.engine.answer(ws, conv["id"], query, history, result, doc_ids))


def _stream(state: AppState, sess: Session, ws: Workspace, conversation_id: str, saved_query: str,
            result: AnswerResult, make_events) -> Response:
    """Resposta NDJSON comum ao chat e às ferramentas: limites do link, erros e gravação.

    `saved_query` é o que fica no histórico como pergunta do utilizador.
    """
    budget = state.share.budget if sess.remote else None
    if sess.remote:
        reason = budget.exhausted_reason() if budget else "O link de partilha expirou."
        if reason:
            return JSONResponse({"type": "error", "code": "limit_reached", "message": reason,
                                 "detail": reason}, status_code=429)
        budget.questions_used += 1  # reserva já a pergunta: o limite fica exato mesmo com fila

    async def events():
        completed = False
        try:
            async for ev in make_events():
                yield _line(ev)
            completed = True
        except TimeoutError:
            yield _line({"type": "error", "code": "timeout", "message": "A resposta demorou demasiado. Tenta de novo."})
        except (httpx.ConnectError, httpx.HTTPStatusError) as exc:
            log.warning("Ollama indisponível: %s", type(exc).__name__)
            yield _line({"type": "error", "code": "llm_unavailable",
                         "message": "O modelo local não está disponível (o Ollama está a correr?)."})
        except Exception:
            log.exception("Erro ao gerar a resposta")
            yield _line({"type": "error", "code": "internal", "message": "Erro interno ao gerar a resposta."})
        finally:
            if budget is not None:
                if completed:
                    budget.tokens_used += result.usage.total
                else:
                    budget.questions_used -= 1  # falhou: devolver ao orçamento
        if not completed:
            return
        await asyncio.to_thread(convs.save_exchange, ws, conversation_id, saved_query, result.answer, result.sources,
                                result.usage.prompt_tokens, result.usage.gen_tokens)
        await asyncio.to_thread(libs.record_use, ws, conversation_id)
        yield _line({
            "type": "done",
            "usage": {"prompt_tokens": result.usage.prompt_tokens, "gen_tokens": result.usage.gen_tokens},
            "rewritten_query": result.rewritten_query,
            "questions_left": budget.questions_left if budget else None,
            "tokens_left": budget.tokens_left if budget else None,
        })

    return StreamingResponse(
        events(), media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


# ---------- casos práticos ----------

class ModelAnswerBody(BaseModel):
    doc_ids: list[str] = Field(min_length=1, max_length=20)


class SolveBody(BaseModel):
    doc_ids: list[str] = Field(min_length=1, max_length=20)
    case_text: str | None = Field(default=None, max_length=MAX_CASE_CHARS)
    case_doc_id: str | None = None


def _selected_docs(ws: Workspace, conversation_id: str, ids: list[str]) -> list[dict]:
    by_id = {d["id"]: d for d in docs.list_documents(ws, conversation_id)}
    if any(i not in by_id for i in ids):
        raise HTTPException(400, "Documento desconhecido nesta conversa.")
    return [by_id[i] for i in dict.fromkeys(ids)]


@router.post("/conversations/{conversation_id}/model-answer")
async def model_answer(body: ModelAnswerBody, conv: dict = Depends(owned_conversation),
                       ws: Workspace = Depends(current_ws), sess: Session = Depends(current_session),
                       state: AppState = Depends(get_state)):
    selected = _selected_docs(ws, conv["id"], body.doc_ids)
    label = f"{MODEL_ANSWER_LABEL} com base em: " + ", ".join(d["filename"] for d in selected)
    result = AnswerResult()
    return _stream(state, sess, ws, conv["id"], label, result,
                   lambda: state.tools.model_answer(ws, conv["id"], selected, result))


@router.post("/conversations/{conversation_id}/solve")
async def solve_case(body: SolveBody, conv: dict = Depends(owned_conversation),
                     ws: Workspace = Depends(current_ws), sess: Session = Depends(current_session),
                     state: AppState = Depends(get_state)):
    case_text = (body.case_text or "").strip()
    if not case_text and not body.case_doc_id:
        raise HTTPException(400, "Falta o enunciado do caso.")
    case_doc = _selected_docs(ws, conv["id"], [body.case_doc_id])[0] if body.case_doc_id else None
    refs = [d for d in _selected_docs(ws, conv["id"], body.doc_ids) if not case_doc or d["id"] != case_doc["id"]]
    if not refs:
        raise HTTPException(400, "Escolhe pelo menos um documento de referência além do caso.")
    head = f"{SOLVE_LABEL} com base em: " + ", ".join(d["filename"] for d in refs)
    label = head + (f"\n\nCaso: {case_doc['filename']}" if case_doc else f"\n\n{case_text}")
    result = AnswerResult()
    return _stream(state, sess, ws, conv["id"], label, result,
                   lambda: state.tools.solve(ws, conv["id"], refs, case_text or None, case_doc, result))


# ---------- imagens do perfil (foto e fundos) ----------

@router.get("/profile/media/{kind}")
def get_media(kind: str, ws: Workspace = Depends(current_ws)):
    found = media.load(ws, kind)
    if found is None:
        raise HTTPException(404, "Imagem não encontrada.")
    data, ctype = found
    # O URL leva a versão (?v=), por isso pode ficar em cache.
    return Response(data, media_type=ctype, headers={"Cache-Control": "private, max-age=31536000, immutable"})


@router.put("/profile/media/{kind}")
async def put_media(kind: str, file: UploadFile = File(...), ws: Workspace = Depends(current_ws)):
    data = await file.read(media.MAX_UPLOAD_MB * 1024 * 1024 + 1)
    try:
        await asyncio.to_thread(media.save, ws, kind, data)
    except media.MediaError as e:
        raise HTTPException(e.status, str(e))
    return media.versions(ws)


@router.delete("/profile/media/{kind}")
def delete_media(kind: str, ws: Workspace = Depends(current_ws)):
    if kind not in media.KINDS:
        raise HTTPException(404, "Tipo de imagem desconhecido.")
    media.delete(ws, kind)
    return media.versions(ws)


# ---------- partilha por link (só a partir deste computador) ----------

class ShareStartBody(BaseModel):
    minutes: int | None = Field(ge=5, le=31 * 24 * 60)  # null: até parar
    max_questions: int | None = Field(default=None, ge=1, le=10_000)
    max_tokens: int | None = Field(default=None, ge=100, le=10_000_000)


class ShareExtendBody(BaseModel):
    minutes: int = Field(ge=5, le=24 * 60)


def local_session(sess: Session = Depends(current_session), state: AppState = Depends(get_state)) -> Session:
    """Só o perfil de administrador gere a partilha, e só a partir deste computador."""
    if sess.remote:
        raise HTTPException(403, "A partilha só se gere a partir deste computador.")
    if sess.profile != state.settings.admin_profile:
        raise HTTPException(403, "Só o administrador pode gerir a partilha.")
    return sess


def _share_info(state: AppState, me: Session) -> dict:
    """Estado do link e quem está ligado agora (por perfil: neste computador e/ou pelo link)."""
    sessions = state.sessions.active()
    accounts = []
    for slug, p in state.registry.profiles.items():
        mine = [s for s in sessions if s.profile == slug]
        accounts.append({
            "profile": slug,
            "display_name": p["display_name"],
            "is_me": slug == me.profile,
            "local": sum(not s.remote for s in mine),
            "remote": sum(s.remote for s in mine),
            "online": bool(mine),
        })
    return {**state.share_manager.status(), "accounts": accounts,
            "default_minutes": state.settings.share_default_minutes}


@router.get("/share")
def share_info(sess: Session = Depends(local_session), state: AppState = Depends(get_state)):
    return _share_info(state, sess)


@router.post("/share/start")
async def share_start(body: ShareStartBody, sess: Session = Depends(local_session),
                      state: AppState = Depends(get_state)):
    try:
        await state.share_manager.start(body.minutes, body.max_questions, body.max_tokens)
    except ShareError as e:
        raise HTTPException(e.status, e.message)
    return _share_info(state, sess)


@router.post("/share/extend")
def share_extend(body: ShareExtendBody, sess: Session = Depends(local_session), state: AppState = Depends(get_state)):
    try:
        state.share_manager.extend(body.minutes)
    except ShareError as e:
        raise HTTPException(e.status, e.message)
    return _share_info(state, sess)


@router.post("/share/stop")
async def share_stop(sess: Session = Depends(local_session), state: AppState = Depends(get_state)):
    await state.share_manager.stop()
    return _share_info(state, sess)


# ---------- definições ----------

@router.get("/settings")
def get_settings(ws: Workspace = Depends(current_ws)):
    return user_settings.load(ws.db_path)


@router.put("/settings")
async def put_settings(request: Request, ws: Workspace = Depends(current_ws)):
    try:
        data = await request.json()
    except ValueError:
        raise HTTPException(400, "JSON inválido.")
    try:
        return user_settings.save(ws.db_path, data)
    except user_settings.SettingsError as e:
        raise HTTPException(400, str(e))

