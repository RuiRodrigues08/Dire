"""SQLite por perfil (modo WAL, foreign_keys=ON). Esquema do blueprint 3.3."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL DEFAULT 'Nova conversa',
  pinned           INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  file_type       TEXT NOT NULL CHECK (file_type IN ('pdf','pptx')),
  sha256          TEXT NOT NULL,
  n_chunks        INTEGER NOT NULL,
  stored_path     TEXT NOT NULL,
  uploaded_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  sources_json    TEXT,
  prompt_tokens   INTEGER,
  gen_tokens      INTEGER,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_conv_activity ON conversations(pinned, last_activity_at);
CREATE INDEX IF NOT EXISTS idx_documents_conv ON documents(conversation_id);

CREATE TABLE IF NOT EXISTS settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data_json  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"""

_initialized: set[str] = set()


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value)


@contextmanager
def connect(db_path: Path):
    """Uma ligação por operação; commit no fim, rollback em erro."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        if str(db_path) not in _initialized:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(SCHEMA)
            _initialized.add(str(db_path))
        conn.execute("BEGIN")
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
