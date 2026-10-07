"""Fila de inferência (1 de cada vez, com posição) e orçamento do link de partilha."""
from __future__ import annotations

import asyncio
import itertools
import time
from collections import deque
from dataclasses import dataclass


class InferenceQueue:
    """Fila FIFO de 1 lugar. `position(ticket)` = quantos pedidos estão à frente."""

    def __init__(self) -> None:
        self._tickets: deque[int] = deque()
        self._counter = itertools.count()
        self._changed = asyncio.Event()

    def take_ticket(self) -> int:
        t = next(self._counter)
        self._tickets.append(t)
        return t

    def position(self, ticket: int) -> int:
        return self._tickets.index(ticket)

    async def wait_for_change(self) -> None:
        event = self._changed
        await event.wait()

    def release(self, ticket: int) -> None:
        """Sai da fila (terminou, falhou ou o cliente desligou antes da sua vez)."""
        try:
            self._tickets.remove(ticket)
        except ValueError:
            return
        old, self._changed = self._changed, asyncio.Event()
        old.set()

    @property
    def size(self) -> int:
        return len(self._tickets)


@dataclass
class LinkBudget:
    """Limites de um link ativo (6.5). Vivem em memória, como no blueprint."""

    expires_at: float
    max_questions: int | None = None
    max_tokens: int | None = None
    questions_used: int = 0
    tokens_used: int = 0

    @property
    def active(self) -> bool:
        return time.time() < self.expires_at

    @property
    def questions_left(self) -> int | None:
        return None if self.max_questions is None else max(0, self.max_questions - self.questions_used)

    @property
    def tokens_left(self) -> int | None:
        return None if self.max_tokens is None else max(0, self.max_tokens - self.tokens_used)

    def exhausted_reason(self) -> str | None:
        if not self.active:
            return "O link de partilha expirou."
        if self.questions_left == 0:
            return "Foi atingido o limite de perguntas deste link."
        if self.tokens_left == 0:
            return "Foi atingido o limite de tokens deste link."
        return None

    def consume(self, tokens: int) -> None:
        self.questions_used += 1
        self.tokens_used += tokens


class ShareState:
    """Estado do link visto pela API pública. O Share Manager (Fase 4) gere-o."""

    def __init__(self) -> None:
        self.budget: LinkBudget | None = None
        self.epoch = 0  # muda quando o link pára/expira: invalida sessões remotas

    def is_active(self) -> bool:
        return self.budget is not None and self.budget.active

    def start(self, minutes: int, max_questions: int | None = None, max_tokens: int | None = None) -> LinkBudget:
        self.epoch += 1
        self.budget = LinkBudget(time.time() + minutes * 60, max_questions, max_tokens)
        return self.budget

    def extend(self, minutes: int) -> None:
        if self.budget:
            self.budget.expires_at += minutes * 60

    def stop(self) -> None:
        self.budget = None
        self.epoch += 1
