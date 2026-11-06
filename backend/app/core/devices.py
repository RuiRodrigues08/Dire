"""Dispositivos que entram pelo link de partilha: histórico, aprovação e bloqueio.

Um dispositivo é identificado por um token aleatório num cookie (`rag_device`) que o servidor
atribui. Só se guarda o hash do token. Ao contrário do IP, sobrevive a VPNs e a redes
diferentes. Limite assumido: quem apagar os cookies passa a ser um dispositivo novo, e por isso
os dispositivos novos ficam pendentes até o administrador os aprovar (ver `require_approval`).
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import threading
import time
from pathlib import Path

DEVICE_COOKIE = "rag_device"
MAX_IPS = 8
MAX_DEVICES = 200


def device_key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()[:16]


def new_token() -> str:
    return secrets.token_urlsafe(24)


def valid_token(token: str | None) -> bool:
    return bool(token) and re.fullmatch(r"[A-Za-z0-9_-]{20,64}", token) is not None


def describe_agent(ua: str) -> str:
    """Resumo legível do User-Agent (é só uma pista, não uma identificação fiável)."""
    ua = ua or ""
    os_ = next((n for p, n in (("Windows", "Windows"), ("Android", "Android"), ("iPhone", "iPhone"),
                               ("iPad", "iPad"), ("Mac OS X", "macOS"), ("CrOS", "ChromeOS"),
                               ("Linux", "Linux")) if p in ua), "Sistema desconhecido")
    browser = next((n for p, n in (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"),
                                   ("Chrome/", "Chrome"), ("CriOS/", "Chrome"), ("Safari/", "Safari"))
                    if p in ua), "Navegador desconhecido")
    return f"{browser} em {os_}"


class DeviceStore:
    def __init__(self, path: Path, require_approval: bool = True):
        self.path = path
        self._lock = threading.Lock()
        self._data = {"require_approval": require_approval, "devices": {}}
        if path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                self._data["devices"] = loaded.get("devices", {})
                self._data["require_approval"] = bool(loaded.get("require_approval", require_approval))
            except (ValueError, OSError):
                pass

    # -- persistência --
    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.path)

    @property
    def require_approval(self) -> bool:
        return self._data["require_approval"]

    def set_require_approval(self, value: bool) -> None:
        with self._lock:
            self._data["require_approval"] = bool(value)
            self._save()

    # -- consultas --
    def status(self, token: str | None) -> str | None:
        if not valid_token(token):
            return None
        with self._lock:
            d = self._data["devices"].get(device_key(token))
            return d["status"] if d else None

    def list(self) -> list[dict]:
        with self._lock:
            return sorted((dict(id=k, **v) for k, v in self._data["devices"].items()),
                          key=lambda d: d["last_seen"], reverse=True)

    # -- escrita --
    def failed_attempt(self, token: str | None) -> None:
        """Código errado vindo de um dispositivo já conhecido (não cria registos novos: evita spam)."""
        if not valid_token(token):
            return
        with self._lock:
            d = self._data["devices"].get(device_key(token))
            if d:
                d["failed"] = d.get("failed", 0) + 1
                self._save()

    def register(self, token: str, profile: str, ip: str, ua: str) -> str:
        """Regista um login com código válido. Devolve o estado: approved | pending | blocked."""
        now = int(time.time())
        key = device_key(token)
        ua_hash = hashlib.sha256((ua or "").encode()).hexdigest()[:16] if ua else None
        with self._lock:
            devices = self._data["devices"]
            d = devices.get(key)
            if d is None:
                if len(devices) >= MAX_DEVICES:  # esquecer os mais antigos que não estão aprovados
                    for k, _ in sorted(((k, v) for k, v in devices.items() if v["status"] != "approved"),
                                       key=lambda kv: kv[1]["last_seen"])[:20]:
                        del devices[k]
                # Link novo = endereço novo = cookie novo. Se este perfil já tem aqui um dispositivo
                # aprovado com o mesmo User-Agent exato, é o mesmo aparelho: herda a aprovação.
                known = any(v["status"] == "approved" and v.get("ua") == ua_hash and profile in v["profiles"]
                            for v in devices.values())
                d = devices[key] = {
                    "status": "approved" if known or not self._data["require_approval"] else "pending",
                    "ua": ua_hash,
                    "first_seen": now, "logins": 0, "failed": 0, "profiles": [], "ips": [],
                }
            d.update(last_seen=now, agent=describe_agent(ua), last_ip=ip)
            d["ips"] = ([ip] + [x for x in d["ips"] if x != ip])[:MAX_IPS]
            if profile not in d["profiles"]:
                d["profiles"].append(profile)
            if d["status"] == "approved":
                d["logins"] += 1
            self._save()
            return d["status"]

    def set_status(self, key: str, status: str) -> bool:
        with self._lock:
            d = self._data["devices"].get(key)
            if d is None:
                return False
            d["status"] = status
            self._save()
            return True

    def forget(self, key: str) -> bool:
        with self._lock:
            found = self._data["devices"].pop(key, None) is not None
            if found:
                self._save()
            return found
