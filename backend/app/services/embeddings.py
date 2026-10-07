"""Embeddings densos. Produção: bge-m3 (SentenceTransformers, CPU por omissão).

`HashEmbedder` é um substituto leve e determinístico (saco de palavras com hashing)
para testes e para experimentar a app sem descarregar o modelo. Não serve para
calibrar o threshold: as semelhanças têm outra escala.
"""
from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from functools import lru_cache
from typing import Protocol


class Embedder(Protocol):
    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...
    def embed_query(self, text: str) -> list[float]: ...


class BgeM3Embedder:
    def __init__(self, model_name: str = "BAAI/bge-m3", device: str = "cpu", batch_size: int = 8):
        from sentence_transformers import SentenceTransformer

        self.model = SentenceTransformer(model_name, device=device)
        self.model.max_seq_length = 1024  # blocos de ~500-800 tokens cabem com folga
        self.batch_size = batch_size

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        vecs = self.model.encode(
            texts, batch_size=self.batch_size, normalize_embeddings=True, show_progress_bar=False
        )
        return [v.tolist() for v in vecs]

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]


_STOP = {
    "a", "o", "as", "os", "de", "do", "da", "dos", "das", "e", "é", "em", "no", "na", "nos", "nas",
    "um", "uma", "que", "se", "por", "para", "com", "como", "ao", "à", "qual", "quais", "the", "of",
    "and", "is", "what", "how", "to", "in", "slide", "pag",
}


def _strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


class HashEmbedder:
    def __init__(self, dim: int = 512):
        self.dim = dim

    def _vec(self, text: str) -> list[float]:
        v = [0.0] * self.dim
        for w in re.findall(r"\w+", text.lower()):
            if w in _STOP or len(w) < 2:
                continue
            stem = _strip_accents(w)[:5]
            h = int(hashlib.md5(stem.encode()).hexdigest(), 16)
            v[h % self.dim] += 1.0 if (h >> 64) & 1 else -1.0
        norm = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / norm for x in v]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._vec(text)


@lru_cache(maxsize=4)
def get_embedder(backend: str, model_name: str, device: str) -> Embedder:
    if backend == "hash":
        return HashEmbedder()
    return BgeM3Embedder(model_name, device)
