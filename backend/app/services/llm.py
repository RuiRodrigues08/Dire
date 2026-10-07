"""Cliente Ollama direto (httpx): streaming, `options` e contagem de tokens."""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx


@dataclass
class Usage:
    prompt_tokens: int = 0
    gen_tokens: int = 0

    def __iadd__(self, other: "Usage") -> "Usage":
        self.prompt_tokens += other.prompt_tokens
        self.gen_tokens += other.gen_tokens
        return self

    @property
    def total(self) -> int:
        return self.prompt_tokens + self.gen_tokens


class OllamaClient:
    def __init__(self, base_url: str, model: str, num_ctx: int, seed: int, timeout: float = 120):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.num_ctx = num_ctx
        self.seed = seed
        self.timeout = timeout

    def _options(self, num_predict: int) -> dict:
        return {"temperature": 0.0, "seed": self.seed, "num_ctx": self.num_ctx, "num_predict": num_predict}

    async def complete(self, messages: list[dict], num_predict: int) -> tuple[str, Usage]:
        """Chamada sem streaming (reescrita da pergunta)."""
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.post(
                f"{self.base_url}/api/chat",
                json={"model": self.model, "messages": messages, "stream": False,
                      "options": self._options(num_predict), "keep_alive": "30m"},
            )
            r.raise_for_status()
            data = r.json()
        return data["message"]["content"], Usage(data.get("prompt_eval_count", 0), data.get("eval_count", 0))

    async def stream(self, messages: list[dict], num_predict: int, usage: Usage) -> AsyncIterator[str]:
        """Gera tokens; no fim soma os contadores do Ollama em `usage`."""
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream(
                "POST", f"{self.base_url}/api/chat",
                json={"model": self.model, "messages": messages, "stream": True,
                      "options": self._options(num_predict), "keep_alive": "30m"},
            ) as r:
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if not line.strip():
                        continue
                    data = json.loads(line)
                    if data.get("error"):
                        raise RuntimeError(data["error"])
                    piece = data.get("message", {}).get("content", "")
                    if piece:
                        yield piece
                    if data.get("done"):
                        usage += Usage(data.get("prompt_eval_count", 0), data.get("eval_count", 0))
