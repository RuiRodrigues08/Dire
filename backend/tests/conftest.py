from __future__ import annotations

import asyncio
import json
import os
import re

import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient

from app.services.llm import Usage

CODES = {"rui": "lontra-cometa-farol-7", "namorada": "tulipa-ponte-marfim-3"}
ANSWER = "O overfitting evita-se com regularização e dropout [ml.pdf, Pág. 3]."


class FakeLLM:
    """Substituto do Ollama: regista as chamadas e responde de forma determinística."""

    def __init__(self, delay: float = 0.0):
        self.delay = delay
        self.rewrite_calls: list[str] = []
        self.stream_calls: list[list[dict]] = []

    async def complete(self, messages, num_predict):
        prompt = messages[-1]["content"]
        self.rewrite_calls.append(prompt)
        query = prompt.split("NOVA PERGUNTA:")[-1].strip()
        if re.search(r"overfitting", prompt.split("NOVA PERGUNTA:")[0], re.I) and "evita" in query:
            return "Como se evita o overfitting?", Usage(40, 8)
        return query, Usage(30, 5)

    async def stream(self, messages, num_predict, usage):
        self.stream_calls.append(messages)
        for word in ANSWER.split(" "):
            if self.delay:
                await asyncio.sleep(self.delay)
            yield word + " "
        usage += Usage(200, 20)


@pytest.fixture
def env(tmp_path, monkeypatch):
    ph = PasswordHasher(time_cost=1, memory_cost=8192)
    profiles = {
        "rui": {"display_name": "Rui", "code_hash": ph.hash(CODES["rui"])},
        "namorada": {"display_name": "Ana", "code_hash": ph.hash(CODES["namorada"])},
    }
    pf = tmp_path / "profiles.json"
    pf.write_text(json.dumps(profiles))
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("PROFILES_FILE", str(pf))
    monkeypatch.setenv("FRONTEND_DIST", str(tmp_path / "no-dist"))
    monkeypatch.setenv("SESSION_SECRET", "x" * 48)
    monkeypatch.setenv("EMBEDDINGS_BACKEND", "hash")
    monkeypatch.setenv("SCORE_THRESHOLD", "0.4")
    return tmp_path


@pytest.fixture
def make_app(env):
    from app.core.config import load_settings
    from app.core.state import build_state
    from app.main import create_admin_app, create_public_app
    from app.services.embeddings import HashEmbedder

    def _make(llm=None, embedder=None):
        llm = llm or FakeLLM()
        state = build_state(load_settings(), llm=llm, embedder=embedder or HashEmbedder())
        return state, llm, create_public_app(state, background=False), create_admin_app(state)

    return _make


@pytest.fixture
def app_ctx(make_app):
    state, llm, public, admin = make_app()
    with TestClient(public) as client:
        yield state, llm, client


def login(client, profile, headers=None):
    r = client.post("/api/auth/login", json={"code": CODES[profile]}, headers=headers or {})
    assert r.status_code == 200, r.text
    return r


def read_ndjson(response) -> list[dict]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]
