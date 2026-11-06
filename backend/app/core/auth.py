"""Códigos de acesso (argon2), anti força bruta por IP e sessões em cookie assinado."""
from __future__ import annotations

import json
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from itsdangerous import BadSignature, URLSafeSerializer

from .limits import ShareState

COOKIE_NAME = "rag_session"
_ph = PasswordHasher()


class ProfileRegistry:
    """Perfis fixos de `profiles.json`: {slug: {display_name, code_hash}}."""

    def __init__(self, path: Path):
        data = json.loads(path.read_text(encoding="utf-8"))
        self.profiles: dict[str, dict] = {
            slug: {"display_name": p.get("display_name", slug), "code_hash": p["code_hash"]}
            for slug, p in data.items()
        }
        if not self.profiles:
            raise ValueError("profiles.json não tem perfis.")
        # Hash de reserva: garante pelo menos uma verificação argon2 mesmo sem perfis válidos.
        self._dummy = _ph.hash(secrets.token_hex(16))

    def verify(self, code: str) -> str | None:
        """Verifica contra TODOS os perfis, para o tempo de resposta não revelar nada."""
        match = None
        hashes = [(slug, p["code_hash"]) for slug, p in self.profiles.items()] or [(None, self._dummy)]
        for slug, h in hashes:
            try:
                if _ph.verify(h, code) and match is None:
                    match = slug
            except (VerifyMismatchError, VerificationError, InvalidHashError):
                pass
        return match

    def display_name(self, slug: str) -> str:
        return self.profiles[slug]["display_name"]


class LoginLimiter:
    """N falhas seguidas bloqueiam o IP durante M minutos."""

    def __init__(self, max_failures: int, lockout_minutes: int):
        self.max_failures = max_failures
        self.lockout = lockout_minutes * 60
        self._fails: dict[str, int] = {}
        self._locked_until: dict[str, float] = {}
        self._lock = threading.Lock()

    def retry_after(self, ip: str) -> int:
        with self._lock:
            until = self._locked_until.get(ip, 0)
            if until and until <= time.time():
                self._locked_until.pop(ip, None)
                self._fails.pop(ip, None)
                return 0
            return max(0, int(until - time.time()))

    def failure(self, ip: str) -> int:
        """Regista uma falha; devolve os segundos de bloqueio (0 se ainda não bloqueou)."""
        with self._lock:
            n = self._fails.get(ip, 0) + 1
            self._fails[ip] = n
            if n >= self.max_failures:
                self._locked_until[ip] = time.time() + self.lockout
                return self.lockout
            return 0

    def success(self, ip: str) -> None:
        with self._lock:
            self._fails.pop(ip, None)


@dataclass
class Session:
    sid: str
    profile: str
    remote: bool
    expires_at: float
    share_epoch: int = 0
    device: str | None = None  # chave do dispositivo (só em sessões remotas)
    ip: str = ""
    agent: str = ""
    created_at: float = 0.0


class SessionManager:
    """Sessões no servidor (revogáveis); o cookie só transporta o id assinado.

    Sessões remotas valem min(2 h, expiração do link) e morrem quando o link pára
    (a `epoch` da partilha muda). Reiniciar a app termina todas as sessões.
    """

    def __init__(self, secret: str, share: ShareState, local_hours: int, remote_max_minutes: int):
        if len(secret) < 32:
            raise ValueError("SESSION_SECRET tem de ter pelo menos 32 caracteres.")
        self._signer = URLSafeSerializer(secret, salt="rag-session")
        self.share = share
        self.local_seconds = local_hours * 3600
        self.remote_seconds = remote_max_minutes * 60
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def create(self, profile: str, remote: bool, device: str | None = None, ip: str = "",
               agent: str = "") -> tuple[Session, str]:
        now = time.time()
        if remote:
            budget = self.share.budget
            exp = min(now + self.remote_seconds, budget.expires_at if budget else now)
        else:
            exp = now + self.local_seconds
        sess = Session(secrets.token_urlsafe(24), profile, remote, exp, self.share.epoch, device, ip, agent, now)
        with self._lock:
            self._purge(now)
            self._sessions[sess.sid] = sess
        return sess, self._signer.dumps({"sid": sess.sid, "profile": profile, "remote": remote, "exp": int(exp)})

    def validate(self, token: str | None, request_is_remote: bool) -> Session | None:
        if not token:
            return None
        try:
            data = self._signer.loads(token)
        except BadSignature:
            return None
        with self._lock:
            sess = self._sessions.get(data.get("sid"))
        if sess is None or sess.profile != data.get("profile"):
            return None
        if time.time() >= sess.expires_at:
            self.delete(sess.sid)
            return None
        if request_is_remote and not sess.remote:
            return None  # uma sessão local nunca é aceite através do túnel
        if sess.remote:
            if sess.share_epoch != self.share.epoch or not self.share.is_active():
                self.delete(sess.sid)
                return None
            sess.expires_at = min(sess.expires_at, self.share.budget.expires_at)
        return sess

    def delete(self, sid: str) -> None:
        with self._lock:
            self._sessions.pop(sid, None)

    def revoke_remote(self) -> int:
        with self._lock:
            remote = [sid for sid, s in self._sessions.items() if s.remote]
            for sid in remote:
                del self._sessions[sid]
        return len(remote)

    def revoke_device(self, device: str) -> int:
        with self._lock:
            ids = [sid for sid, s in self._sessions.items() if s.device == device]
            for sid in ids:
                del self._sessions[sid]
        return len(ids)

    def active(self) -> list[Session]:
        with self._lock:
            self._purge(time.time())
            return list(self._sessions.values())

    def _purge(self, now: float) -> None:
        for sid in [sid for sid, s in self._sessions.items() if s.expires_at <= now]:
            del self._sessions[sid]


def is_remote_request(headers) -> bool:
    """O Cloudflare adiciona sempre estes headers a pedidos que passam pelo túnel."""
    return "cf-connecting-ip" in headers or "cf-ray" in headers


def client_ip(request) -> str:
    if is_remote_request(request.headers):
        return request.headers.get("cf-connecting-ip", "cloudflare")
    return request.client.host if request.client else "local"
