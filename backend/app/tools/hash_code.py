"""Gera o hash argon2 de um código de acesso (o código em claro nunca é guardado).

  python -m app.tools.hash_code                  # pede o código e imprime o hash
  python -m app.tools.hash_code --profile admin  # muda o código do perfil em profiles.json
  python -m app.tools.hash_code --suggest        # sugere um código de 4 dígitos aleatório

O ecrã de login só aceita códigos de 4 dígitos (LEN em frontend/src/components/auth/otpShared.jsx).
"""
from __future__ import annotations

import argparse
import getpass
import json
import re
import secrets

from argon2 import PasswordHasher

from ..core.config import load_settings

CODE_RE = re.compile(r"\d{4}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--suggest", action="store_true", help="sugerir um código de 4 dígitos")
    ap.add_argument("--profile", help="gravar o hash neste perfil de profiles.json (ex.: admin, user)")
    args = ap.parse_args()
    if args.suggest:
        print("Sugestão:", f"{secrets.randbelow(10_000):04d}")
        return
    code = getpass.getpass("Código (4 dígitos): ")
    if not CODE_RE.fullmatch(code):
        raise SystemExit("O código tem de ter exatamente 4 dígitos.")
    if code != getpass.getpass("Repetir: "):
        raise SystemExit("Os códigos não coincidem.")
    ph = PasswordHasher()
    if not args.profile:
        print(ph.hash(code))
        return
    path = load_settings().profiles_file
    profiles = json.loads(path.read_text(encoding="utf-8"))
    if args.profile not in profiles:
        raise SystemExit(f"Perfil desconhecido: {args.profile} (existem: {', '.join(profiles)})")
    others = [slug for slug, p in profiles.items() if slug != args.profile and _matches(ph, p["code_hash"], code)]
    if others:
        raise SystemExit("Esse código já é usado por outro perfil.")
    profiles[args.profile]["code_hash"] = ph.hash(code)
    path.write_text(json.dumps(profiles, ensure_ascii=False, indent=2), encoding="utf-8")
    path.chmod(0o600)
    print(f"Código de {args.profile} atualizado em {path}. Reinicia o backend para entrar em vigor.")


def _matches(ph: PasswordHasher, h: str, code: str) -> bool:
    try:
        return ph.verify(h, code)
    except Exception:
        return False


if __name__ == "__main__":
    main()
