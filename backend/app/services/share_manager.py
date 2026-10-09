"""Share Manager (blueprint 6): o link público por Quick Tunnel do Cloudflare.

Arranca `cloudflared tunnel --url http://127.0.0.1:<porta>` como subprocesso, lê o URL
`https://*.trycloudflare.com` do output e ativa o orçamento do link (ShareState). Parar,
expirar ou o túnel morrer: termina o processo e invalida as sessões remotas.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import re
import shutil
import time

from ..core.auth import SessionManager
from ..core.limits import ShareState

log = logging.getLogger("rag.share")
URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
START_TIMEOUT = 30


class ShareError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


class ShareManager:
    def __init__(self, share: ShareState, sessions: SessionManager, port: int, binary: str):
        self.share = share
        self.sessions = sessions
        self.port = port
        self.binary = binary
        self.url: str | None = None
        self.started_at: float | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._drain: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def start(self, minutes: int | None, max_questions: int | None = None, max_tokens: int | None = None) -> dict:
        async with self._lock:
            if self.running:
                raise ShareError("A partilha já está ativa.", 409)
            exe = shutil.which(self.binary)
            if not exe:
                raise ShareError(
                    "O cloudflared não está instalado neste computador. Instala-o (ex.: o pacote .deb em "
                    "github.com/cloudflare/cloudflared/releases) ou indica o caminho em CLOUDFLARED_BIN.", 503)
            proc = await asyncio.create_subprocess_exec(
                exe, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{self.port}",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
            )
            try:
                url = await asyncio.wait_for(self._read_url(proc), START_TIMEOUT)
            except (asyncio.TimeoutError, EOFError):
                await self._kill(proc)
                raise ShareError("O cloudflared não devolveu um link a tempo. Verifica a ligação à internet.", 504)
            self._proc, self.url, self.started_at = proc, url, time.time()
            self.share.start(minutes, max_questions, max_tokens)
            self._drain = asyncio.create_task(self._watch(proc))
            log.info("Partilha ativa: %s (%s)", url, f"{minutes} min" if minutes else "até parar")
            return self.status()

    @staticmethod
    async def _read_url(proc) -> str:
        while True:
            line = await proc.stderr.readline()
            if not line:
                raise EOFError
            m = URL_RE.search(line.decode("utf-8", "replace"))
            if m:
                return m.group(0)

    async def _watch(self, proc) -> None:
        """Esvazia o stderr (senão o processo bloqueia) e, se o túnel morrer, desliga a partilha."""
        with contextlib.suppress(Exception):
            while await proc.stderr.readline():
                pass
        await proc.wait()
        if proc is self._proc:
            log.warning("O cloudflared terminou; partilha desligada.")
            self._clear()

    def _clear(self) -> None:
        self._proc, self.url, self.started_at = None, None, None
        self.share.stop()
        self.sessions.revoke_remote()

    @staticmethod
    async def _kill(proc) -> None:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), 5)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()

    async def stop(self) -> None:
        async with self._lock:
            proc, self._proc = self._proc, None
            if proc is not None:
                await self._kill(proc)
            if self._drain:
                self._drain.cancel()
                self._drain = None
            self._clear()

    def extend(self, minutes: int) -> dict:
        if not self.share.is_active():
            raise ShareError("A partilha não está ativa.", 409)
        self.share.extend(minutes)
        return self.status()

    def status(self) -> dict:
        b = self.share.budget
        active = self.share.is_active() and self.running
        return {
            "active": active,
            "url": self.url if active else None,
            "started_at": int(self.started_at) if active and self.started_at else None,
            "expires_at": int(b.expires_at) if active and b and math.isfinite(b.expires_at) else None,
            "max_questions": b.max_questions if active and b else None,
            "max_tokens": b.max_tokens if active and b else None,
            "questions_used": b.questions_used if active and b else 0,
            "tokens_used": b.tokens_used if active and b else 0,
            "available": shutil.which(self.binary) is not None,
        }
