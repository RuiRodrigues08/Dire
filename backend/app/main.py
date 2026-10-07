"""Arranca a app pública (8000) e a admin (8001) no mesmo processo + tarefas de fundo.

  python -m app.main
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

from .api import admin_routes, public_routes
from .core.config import Settings, load_settings
from .core.state import AppState, build_state
from .services import conversations as convs

log = logging.getLogger("rag")

SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
                               "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
}
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


class GuardMiddleware:
    """Headers de segurança + CSRF: pedidos com corpo só em JSON (upload em multipart).

    Middleware ASGI puro (não `BaseHTTPMiddleware`) para nunca atrasar o stream NDJSON.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        method = scope["method"]
        if method in UNSAFE:
            has_body = int(headers.get("content-length") or 0) > 0 or "transfer-encoding" in headers
            ctype = headers.get("content-type", "").split(";")[0].strip().lower()
            is_upload = method == "POST" and scope["path"].endswith("/documents")
            allowed = {"multipart/form-data"} if is_upload else {"application/json"}
            if has_body and ctype not in allowed:
                resp = JSONResponse({"detail": "Content-Type não permitido."}, status_code=415)
                return await resp(scope, receive, send)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                existing = {k.lower() for k, _ in message.get("headers", [])}
                extra = [(k.lower().encode(), v.encode()) for k, v in SECURITY_HEADERS.items()
                         if k.lower().encode() not in existing]
                message = {**message, "headers": list(message.get("headers", [])) + extra}
            await send(message)

        await self.app(scope, receive, send_with_headers)


def run_maintenance(state: AppState) -> None:
    for profile in state.registry.profiles:
        ws = state.workspace(profile)
        deleted = convs.cleanup_expired(ws)
        rec = convs.reconcile(ws)
        if deleted or rec["orphan_vectors"] or rec["removed_paths"]:
            log.info("Limpeza %s: %d conversas apagadas, %d órfãos de vetores, %d caminhos removidos",
                     profile, len(deleted), len(rec["orphan_vectors"]), len(rec["removed_paths"]))


async def _maintenance_loop(state: AppState) -> None:
    while True:
        await asyncio.sleep(24 * 3600)
        try:
            await asyncio.to_thread(run_maintenance, state)
        except Exception:
            log.exception("Falha na limpeza diária")


async def _share_watchdog(state: AppState) -> None:
    """Quando o link expira, invalida as sessões remotas (Fase 4 também mata o túnel)."""
    while True:
        await asyncio.sleep(15)
        if state.share.budget is not None and not state.share.budget.active:
            state.share.stop()
            state.sessions.revoke_remote()


def create_public_app(state: AppState, background: bool = True) -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        await asyncio.to_thread(run_maintenance, state)  # no arranque (o portátil nem sempre está ligado)
        tasks = [asyncio.create_task(_maintenance_loop(state)), asyncio.create_task(_share_watchdog(state))] if background else []
        yield
        for t in tasks:
            t.cancel()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.rag = state
    app.add_middleware(GuardMiddleware)
    app.include_router(public_routes.router)
    _mount_frontend(app, state.settings.frontend_dist)
    return app


def create_admin_app(state: AppState) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.rag = state
    app.add_middleware(GuardMiddleware)
    app.include_router(admin_routes.router)
    return app


def _mount_frontend(app: FastAPI, dist: Path) -> None:
    """Serve o `vite build` na mesma origem da API (sem CORS). SPA: rotas desconhecidas → index.html."""
    if not (dist / "index.html").is_file():
        return
    root = dist.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path.startswith("api/"):
            return JSONResponse({"detail": "Não encontrado."}, status_code=404)
        candidate = (root / path).resolve()
        if path and candidate.is_file() and root in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(root / "index.html")


async def serve(settings: Settings | None = None) -> None:
    import uvicorn

    settings = settings or load_settings()
    state = build_state(settings)
    public = uvicorn.Server(uvicorn.Config(
        create_public_app(state), host="127.0.0.1", port=settings.public_port,
        proxy_headers=False, access_log=False, log_level="info"))
    admin = uvicorn.Server(uvicorn.Config(
        create_admin_app(state), host="127.0.0.1", port=settings.admin_port, access_log=False, log_level="warning"))
    log.info("Pública: http://127.0.0.1:%d  ·  Admin: http://127.0.0.1:%d", settings.public_port, settings.admin_port)
    await asyncio.gather(public.serve(), admin.serve())


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    asyncio.run(serve())
