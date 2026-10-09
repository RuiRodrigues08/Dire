"""Configuração central: lê o `.env` (se existir) e variáveis de ambiente."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]


def _load_dotenv(path: Path) -> None:
    """Carrega KEY=VALUE do `.env` sem sobrepor variáveis já definidas."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


def _float(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


def _bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "sim"}


@dataclass
class Settings:
    data_dir: Path
    profiles_file: Path
    frontend_dist: Path
    session_secret: str
    ollama_url: str
    ollama_model: str
    num_ctx: int
    num_predict: int
    summary_num_predict: int
    tools_num_ctx: int
    rewrite_num_predict: int
    llm_seed: int
    top_k: int
    score_threshold: float
    history_turns: int
    chat_retention_days: int
    share_default_minutes: int
    cloudflared_bin: str
    admin_profile: str
    remote_session_max_minutes: int
    local_session_hours: int
    login_max_failures: int
    login_lockout_minutes: int
    max_file_mb: int
    max_files_per_conversation: int
    max_files_per_library: int
    max_query_chars: int
    inference_timeout_seconds: int
    embeddings_backend: str          # "bge-m3" (produção) ou "hash" (testes/dev sem modelo)
    embeddings_model: str
    embeddings_device: str
    pdf_parser: str                  # "pymupdf" ou "docling"
    pdf_chunk_tokens: int
    pdf_chunk_overlap: float
    slide_max_tokens: int
    include_speaker_notes: bool
    public_host: str = "127.0.0.1"
    public_port: int = 8000
    extra: dict = field(default_factory=dict)

    @property
    def chroma_dir(self) -> Path:
        return self.data_dir / "chroma"

    def profile_dir(self, profile: str) -> Path:
        return self.data_dir / "profiles" / profile


def load_settings() -> Settings:
    _load_dotenv(BACKEND_DIR / ".env")
    return Settings(
        data_dir=Path(os.environ.get("DATA_DIR", BACKEND_DIR / "data")),
        profiles_file=Path(os.environ.get("PROFILES_FILE", BACKEND_DIR / "profiles.json")),
        frontend_dist=Path(os.environ.get("FRONTEND_DIST", BACKEND_DIR.parent / "frontend" / "dist")),
        session_secret=os.environ.get("SESSION_SECRET", ""),
        ollama_url=os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434"),
        ollama_model=os.environ.get("OLLAMA_MODEL", "qwen2.5:7b-instruct-q4_K_M"),
        num_ctx=_int("NUM_CTX", 4096),
        num_predict=_int("NUM_PREDICT", 500),
        summary_num_predict=_int("SUMMARY_NUM_PREDICT", 1000),
        tools_num_ctx=_int("TOOLS_NUM_CTX", 8192),
        rewrite_num_predict=_int("REWRITE_NUM_PREDICT", 100),
        llm_seed=_int("LLM_SEED", 0),
        top_k=_int("TOP_K", 4),
        score_threshold=_float("SCORE_THRESHOLD", 0.70),
        history_turns=_int("HISTORY_TURNS", 3),
        chat_retention_days=_int("CHAT_RETENTION_DAYS", 60),
        share_default_minutes=_int("SHARE_DEFAULT_MINUTES", 120),
        cloudflared_bin=os.environ.get("CLOUDFLARED_BIN", "cloudflared"),
        admin_profile=os.environ.get("ADMIN_PROFILE", "admin"),
        remote_session_max_minutes=_int("REMOTE_SESSION_MAX_MINUTES", 120),
        local_session_hours=_int("LOCAL_SESSION_HOURS", 24),
        login_max_failures=_int("LOGIN_MAX_FAILURES", 5),
        login_lockout_minutes=_int("LOGIN_LOCKOUT_MINUTES", 15),
        max_file_mb=_int("MAX_FILE_MB", 50),
        max_files_per_conversation=_int("MAX_FILES_PER_CONVERSATION", 5),
        max_files_per_library=_int("MAX_FILES_PER_LIBRARY", 50),
        max_query_chars=_int("MAX_QUERY_CHARS", 2000),
        inference_timeout_seconds=_int("INFERENCE_TIMEOUT_SECONDS", 120),
        embeddings_backend=os.environ.get("EMBEDDINGS_BACKEND", "bge-m3"),
        embeddings_model=os.environ.get("EMBEDDINGS_MODEL", "BAAI/bge-m3"),
        embeddings_device=os.environ.get("EMBEDDINGS_DEVICE", "cpu"),
        pdf_parser=os.environ.get("PDF_PARSER", "pymupdf"),
        pdf_chunk_tokens=_int("PDF_CHUNK_TOKENS", 500),
        pdf_chunk_overlap=_float("PDF_CHUNK_OVERLAP", 0.10),
        slide_max_tokens=_int("SLIDE_MAX_TOKENS", 800),
        include_speaker_notes=_bool("INCLUDE_SPEAKER_NOTES", False),
        public_port=_int("PUBLIC_PORT", 8000),
    )
