"""Constrói os serviços a partir da configuração (partilhado pela API e pela CLI)."""
from __future__ import annotations

from ..core.config import Settings
from .embeddings import get_embedder
from .llm import OllamaClient


def make_embedder(s: Settings):
    return get_embedder(s.embeddings_backend, s.embeddings_model, s.embeddings_device)


def make_llm(s: Settings) -> OllamaClient:
    return OllamaClient(s.ollama_url, s.ollama_model, s.num_ctx, s.llm_seed, timeout=s.inference_timeout_seconds)
