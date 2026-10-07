"""API pública (porta 8000): auth, conversas, documentos, chat NDJSON, definições."""
from __future__ import annotations

import asyncio
import json
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
        "remote": sess.remote,
        "expires_at": int(sess.expires_at),
        "questions_left": None,
        "tokens_left": None,
        "share_expires_at": None,
    }
    if sess.remote and state.share.budget:
        b = state.share.budget
        info.update(questions_left=b.questions_left, tokens_left=b.tokens_left, share_expires_at=int(b.expires_at))
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


@router.get("/conversations")
def list_conversations(ws: Workspace = Depends(current_ws)):
    return convs.list_all(ws)


@router.post("/conversations", status_code=201)
def create_conversation(body: ConversationCreate | None = None, ws: Workspace = Depends(current_ws)):
    return convs.create(ws, body.title if body else None)


@router.patch("/conversations/{conversation_id}")
def patch_conversation(body: ConversationPatch, conv: dict = Depends(owned_conversation),
                       ws: Workspace = Depends(current_ws)):
    return convs.update(ws, conv["id"], title=body.title, pinned=body.pinned)


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


@router.get("/conversations/{conversation_id}/export", response_class=Response)
def export_conversation(conv: dict = Depends(owned_conversation), ws: Workspace = Depends(current_ws)):
    lines = [f"# {conv['title']}", ""]
    for m in convs.messages(ws, conv["id"]):
        who = "**Pergunta:**" if m["role"] == "user" else "**Resposta:**"
        lines += [who, "", m["content"], ""]
        for s in m["sources"] or []:
            unit = "Slide" if s["file_type"] == "pptx" else "Pág."
            lines.append(f"- {s['source']}, {unit} {s['page_number']}")
        if m["sources"]:
            lines.append("")
    return Response("\n".join(lines), media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="conversa.md"'})


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

    budget = state.share.budget if sess.remote else None
    if sess.remote:
        reason = budget.exhausted_reason() if budget else "O link de partilha expirou."
        if reason:
            return JSONResponse({"type": "error", "code": "limit_reached", "message": reason,
                                 "detail": reason}, status_code=429)
        budget.questions_used += 1  # reserva já a pergunta: o limite fica exato mesmo com fila

    history = convs.recent_history(ws, conv["id"], s.history_turns)
    result = AnswerResult()

    async def events():
        completed = False
        try:
            async for ev in state.engine.answer(ws, conv["id"], query, history, result, doc_ids):
                yield _line(ev)
            completed = True
        except TimeoutError:
            yield _line({"type": "error", "code": "timeout", "message": "A resposta demorou demasiado. Tenta de novo."})
        except (httpx.ConnectError, httpx.HTTPStatusError) as exc:
            log.warning("Ollama indisponível: %s", type(exc).__name__)
            yield _line({"type": "error", "code": "llm_unavailable",
                         "message": "O modelo local não está disponível (o Ollama está a correr?)."})
        except Exception:
            log.exception("Erro no chat")
            yield _line({"type": "error", "code": "internal", "message": "Erro interno ao gerar a resposta."})
        finally:
            if budget is not None:
                if completed:
                    budget.tokens_used += result.usage.total
                else:
                    budget.questions_used -= 1  # a pergunta falhou: devolver ao orçamento
        if not completed:
            return
        await asyncio.to_thread(convs.save_exchange, ws, conv["id"], query, result.answer, result.sources,
                                result.usage.prompt_tokens, result.usage.gen_tokens)
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


@router.delete("/settings")
def reset_settings(ws: Workspace = Depends(current_ws)):
    return user_settings.reset(ws.db_path)
