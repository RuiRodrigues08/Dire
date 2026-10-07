"""App admin (porta 8001, só 127.0.0.1, nunca pelo túnel).

Fase 2: estado e revogação de sessões. O controlo do `cloudflared`
(start/extend/stop) chega com o Share Manager na Fase 4.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request

from ..core.auth import is_remote_request

router = APIRouter(prefix="/admin")


def _guard(request: Request):
    # Defesa extra: mesmo que alguém aponte o túnel para esta porta, recusar.
    if is_remote_request(request.headers) or (request.client and request.client.host not in {"127.0.0.1", "::1", "testclient"}):
        raise HTTPException(403, "Só acessível localmente.")
    return request.app.state.rag


@router.get("/share/status")
def share_status(request: Request):
    state = _guard(request)
    b = state.share.budget
    sessions = state.sessions.active()
    return {
        "state": "ativo" if state.share.is_active() else "inativo",
        "url": None,
        "seconds_left": int(b.expires_at - time.time()) if b and b.active else 0,
        "questions_used": b.questions_used if b else 0,
        "tokens_used": b.tokens_used if b else 0,
        "questions_left": b.questions_left if b else None,
        "tokens_left": b.tokens_left if b else None,
        "sessions": {"remote": sum(s.remote for s in sessions), "local": sum(not s.remote for s in sessions)},
        "queue": state.queue.size,
    }


@router.post("/sessions/revoke")
def revoke_sessions(request: Request):
    state = _guard(request)
    return {"revoked": state.sessions.revoke_remote()}
