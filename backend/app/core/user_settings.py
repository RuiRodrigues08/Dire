"""Definições por perfil (aparência e chat). Lista fechada: sem CSS livre (blueprint 9.1)."""
from __future__ import annotations

import json
import re

from .db import connect, utcnow

DEFAULTS: dict = {
    "theme": "dark",  # escuro por omissão; a escolha da pessoa fica guardada
    "accent": "#1E4A62",  # azul do logo
    "font": "sans",
    "font_size": "m",
    "density": "normal",
    "radius": "lg",
    "chat_width": "medium",
    "message_style": "modern",
    "background": "plain",
    "login_background": "default",
    "send_with": "enter",
    "sources_open": False,
    "show_tokens": False,
    "confirm_delete": True,
}

_ENUMS = {
    "theme": {"light", "dark", "system", "sepia", "high_contrast"},
    "font": {"sans", "serif", "mono"},
    "font_size": {"s", "m", "l", "xl"},
    "density": {"compact", "normal", "comfortable"},
    "radius": {"none", "sm", "md", "lg", "xl"},
    "chat_width": {"narrow", "medium", "wide"},
    "message_style": {"modern", "bubbles", "clean"},
    "background": {"plain", "gradient", "mesh", "dots", "image"},
    "login_background": {"default", "gradient", "mesh", "dots", "image"},
    "send_with": {"enter", "ctrl_enter"},
}
_BOOLS = {"sources_open", "show_tokens", "confirm_delete"}
_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")

# Versão do formato guardado. Na 2 mudaram as predefinições da cor e do estilo das mensagens:
# quem ainda tinha as antigas (gravadas junto com o resto) passa para as novas, uma vez.
_REV = 2
_OLD_DEFAULTS = {"accent": "#7C5CFF", "message_style": "bubbles"}


class SettingsError(ValueError):
    pass


def validate(data: object) -> dict:
    if not isinstance(data, dict):
        raise SettingsError("As definições têm de ser um objeto JSON.")
    clean: dict = {}
    for key, value in data.items():
        if key in _ENUMS:
            if not isinstance(value, str) or value not in _ENUMS[key]:
                raise SettingsError(f"Valor inválido para '{key}'.")
        elif key in _BOOLS:
            if not isinstance(value, bool):
                raise SettingsError(f"'{key}' tem de ser verdadeiro ou falso.")
        elif key == "accent":
            if not isinstance(value, str) or not _HEX.match(value):
                raise SettingsError("'accent' tem de ser uma cor #RRGGBB.")
            value = value.upper()
        else:
            raise SettingsError(f"Chave não permitida: '{key}'.")
        clean[key] = value
    return clean


def contrast_text(accent_hex: str) -> str:
    """Cor do texto sobre o destaque: branco se tiver pelo menos 3:1 (AA para texto grande e
    componentes), senão o que contrastar mais. O frontend faz o mesmo cálculo (theme.js)."""
    def lum(c: int) -> float:
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (int(accent_hex[i : i + 2], 16) for i in (1, 3, 5))
    L = 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b)
    white, black = 1.05 / (L + 0.05), (L + 0.05) / 0.05
    return "#FFFFFF" if white >= 3 or white >= black else "#000000"


def _with_derived(data: dict) -> dict:
    return {**data, "accent_text": contrast_text(data["accent"])}


def load(db_path) -> dict:
    with connect(db_path) as db:
        row = db.execute("SELECT data_json FROM settings WHERE id=1").fetchone()
    stored = json.loads(row["data_json"]) if row else {}
    if stored.pop("_rev", 1) < _REV:
        stored = {k: v for k, v in stored.items() if _OLD_DEFAULTS.get(k) != v}
        if row:
            _write(db_path, stored)
    # Valores guardados que deixaram de ser válidos voltam à predefinição.
    merged = dict(DEFAULTS)
    for k, v in stored.items():
        try:
            merged.update(validate({k: v}))
        except SettingsError:
            pass
    return _with_derived(merged)


def _write(db_path, clean: dict) -> None:
    with connect(db_path) as db:
        db.execute(
            "INSERT INTO settings (id, data_json, updated_at) VALUES (1, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at",
            (json.dumps({**clean, "_rev": _REV}), utcnow()),
        )


def save(db_path, data: object) -> dict:
    _write(db_path, validate(data))
    return load(db_path)

