"""Cria o `profiles.json` de forma interativa (os códigos nunca ficam guardados em claro).

  python -m app.tools.init_profiles
"""
from __future__ import annotations

import getpass
import json
import re
from pathlib import Path

from argon2 import PasswordHasher

from ..core.config import load_settings
from .hash_code import CODE_RE


def main() -> None:
    path: Path = load_settings().profiles_file
    if path.exists() and input(f"{path} já existe. Substituir? [s/N] ").strip().lower() != "s":
        return
    ph = PasswordHasher()
    profiles: dict = {}
    codes: list[str] = []
    # "admin" vê o ecrã de login "Decrypter"; os outros perfis veem o do coração.
    for default_slug in ("admin", "user"):
        slug = input(f"Identificador do perfil [{default_slug}]: ").strip() or default_slug
        if not re.fullmatch(r"[a-z0-9_]{1,32}", slug) or slug in profiles:
            raise SystemExit("Identificador inválido ou repetido (só a-z, 0-9 e _).")
        name = input(f"Nome a mostrar [{slug.capitalize()}]: ").strip() or slug.capitalize()
        code = getpass.getpass(f"Código de acesso de {name} (4 dígitos): ")
        if not CODE_RE.fullmatch(code):
            raise SystemExit("O código tem de ter exatamente 4 dígitos.")
        if code != getpass.getpass("Repetir: "):
            raise SystemExit("Os códigos não coincidem.")
        if code in codes:
            raise SystemExit("Os dois perfis têm de ter códigos diferentes.")
        codes.append(code)
        profiles[slug] = {"display_name": name, "code_hash": ph.hash(code)}
    path.write_text(json.dumps(profiles, ensure_ascii=False, indent=2), encoding="utf-8")
    path.chmod(0o600)
    print(f"Gravado {path} com os perfis: {', '.join(profiles)}")


if __name__ == "__main__":
    main()
