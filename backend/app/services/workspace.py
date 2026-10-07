"""Tudo o que pertence a um perfil: BD, coleção de vetores e pasta de uploads.

O perfil vem sempre da sessão do servidor; daqui saem os caminhos e a coleção,
por isso um perfil nunca toca nos dados do outro.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

from ..core.config import Settings
from .vector_store import VectorStore

_SLUG = re.compile(r"^[a-z0-9_]{1,32}$")


@dataclass
class Workspace:
    settings: Settings
    profile: str

    def __post_init__(self):
        if not _SLUG.match(self.profile):
            raise ValueError(f"Slug de perfil inválido: {self.profile!r}")

    @property
    def root(self) -> Path:
        return self.settings.profile_dir(self.profile)

    @property
    def db_path(self) -> Path:
        return self.root / "app.db"

    @property
    def uploads_dir(self) -> Path:
        return self.root / "uploads"

    def conversation_dir(self, conversation_id: str) -> Path:
        return self.uploads_dir / conversation_id

    @cached_property
    def vectors(self) -> VectorStore:
        return VectorStore(self.settings.chroma_dir, self.profile)
