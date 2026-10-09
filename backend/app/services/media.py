"""Imagens do perfil: foto (avatar) e fundos (das conversas e do ecrã de entrada).

Todas são reabertas e regravadas com o Pillow: tira metadados (EXIF, localização), limita o
tamanho e garante que o que fica guardado é mesmo uma imagem.
"""
from __future__ import annotations

import io

from PIL import Image, ImageOps, UnidentifiedImageError

from .workspace import Workspace

KINDS = {
    # tipo: (lado máximo em px, formato, recorte quadrado)
    "avatar": (256, "PNG", True),
    "chat_bg": (2560, "JPEG", False),
    "login_bg": (1920, "JPEG", False),
}
MEDIA_TYPES = {"PNG": "image/png", "JPEG": "image/jpeg"}
MAX_UPLOAD_MB = 10
Image.MAX_IMAGE_PIXELS = 50_000_000  # contra "bombas" de descompressão


class MediaError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _path(ws: Workspace, kind: str):
    return ws.root / "media" / kind


def save(ws: Workspace, kind: str, data: bytes) -> int:
    if kind not in KINDS:
        raise MediaError("Tipo de imagem desconhecido.", 404)
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise MediaError(f"A imagem excede {MAX_UPLOAD_MB} MB.", 413)
    side, fmt, square = KINDS[kind]
    try:
        img = Image.open(io.BytesIO(data))
        if img.format not in {"PNG", "JPEG", "WEBP", "GIF"}:
            raise MediaError("Só são aceites imagens PNG, JPEG, WEBP ou GIF.", 415)
        img = ImageOps.exif_transpose(img)
        img.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise MediaError("O ficheiro não é uma imagem válida.", 415) from exc

    if square:
        img = ImageOps.fit(img.convert("RGBA"), (side, side), Image.LANCZOS)
    else:
        img = img.convert("RGB")
        img.thumbnail((side, side), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, fmt, **({"quality": 85, "optimize": True} if fmt == "JPEG" else {"optimize": True}))
    path = _path(ws, kind)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(out.getvalue())
    return version(ws, kind)


def load(ws: Workspace, kind: str) -> tuple[bytes, str] | None:
    if kind not in KINDS:
        return None
    path = _path(ws, kind)
    if not path.is_file():
        return None
    return path.read_bytes(), MEDIA_TYPES[KINDS[kind][1]]


def delete(ws: Workspace, kind: str) -> None:
    if kind in KINDS:
        _path(ws, kind).unlink(missing_ok=True)


def version(ws: Workspace, kind: str) -> int | None:
    path = _path(ws, kind)
    return int(path.stat().st_mtime * 1000) if path.is_file() else None


def versions(ws: Workspace) -> dict:
    """{tipo: versão ou None}: a versão entra no URL para o browser não usar a imagem antiga."""
    return {k: version(ws, k) for k in KINDS}
