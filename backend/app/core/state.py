"""Objetos partilhados pela app pública e pela app admin (no mesmo processo)."""
from __future__ import annotations

from dataclasses import dataclass, field

from ..services.case_tools import CaseTools
from ..services.rag_engine import RagEngine
from ..services.share_manager import ShareManager
from ..services.workspace import Workspace
from .auth import LoginLimiter, ProfileRegistry, SessionManager
from .config import Settings
from .limits import InferenceQueue, ShareState


@dataclass
class AppState:
    settings: Settings
    registry: ProfileRegistry
    sessions: SessionManager
    limiter: LoginLimiter
    share: ShareState
    queue: InferenceQueue
    engine: RagEngine
    tools: CaseTools
    embedder: object
    share_manager: ShareManager
    _workspaces: dict = field(default_factory=dict)

    def workspace(self, profile: str) -> Workspace:
        if profile not in self.registry.profiles:
            raise KeyError(profile)
        if profile not in self._workspaces:
            self._workspaces[profile] = Workspace(self.settings, profile)
        return self._workspaces[profile]


def build_state(settings: Settings, llm=None, embedder=None) -> AppState:
    from ..services.factory import make_embedder, make_llm

    share = ShareState()
    queue = InferenceQueue()
    embedder = embedder or make_embedder(settings)
    llm = llm or make_llm(settings)
    sessions = SessionManager(settings.session_secret, share, settings.local_session_hours,
                              settings.remote_session_max_minutes)
    return AppState(
        settings=settings,
        registry=ProfileRegistry(settings.profiles_file),
        sessions=sessions,
        limiter=LoginLimiter(settings.login_max_failures, settings.login_lockout_minutes),
        share=share,
        queue=queue,
        engine=RagEngine(settings, llm, embedder, queue),
        tools=CaseTools(settings, llm, embedder, queue),
        embedder=embedder,
        share_manager=ShareManager(share, sessions, settings.public_port, settings.cloudflared_bin),
    )
