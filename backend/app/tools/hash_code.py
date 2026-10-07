"""Gera o hash argon2 de um código de acesso (o código em claro nunca é guardado).

  python -m app.tools.hash_code            # pede o código sem o mostrar
  python -m app.tools.hash_code --suggest  # sugere um código de 3 palavras aleatórias
"""
from __future__ import annotations

import argparse
import getpass
import secrets

from argon2 import PasswordHasher

_WORDS = (
    "abril barco bolota cabra caneta cereja chave cometa duna escada farol figo floresta foguete "
    "gaivota girafa janela lagoa lanterna limão lontra luar mapa marfim mel moinho nuvem oceano "
    "ouriço palmeira pêssego pinha planeta polvo ponte quintal raposa rio romã sardinha seta sino "
    "tigre tomate trevo tulipa urso vela vento violeta zebra"
).split()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--suggest", action="store_true", help="sugerir um código de 3 palavras")
    args = ap.parse_args()
    if args.suggest:
        print("Sugestão:", "-".join(secrets.choice(_WORDS) for _ in range(3)) + f"-{secrets.randbelow(100)}")
        return
    code = getpass.getpass("Código: ")
    if code != getpass.getpass("Repetir: "):
        raise SystemExit("Os códigos não coincidem.")
    if len(code) < 8:
        print("Aviso: códigos com menos de 8 caracteres são fracos num link público.")
    print(PasswordHasher().hash(code))


if __name__ == "__main__":
    main()
