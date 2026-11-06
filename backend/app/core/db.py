"""SQLite por perfil (modo WAL, foreign_keys=ON). Esquema do blueprint 3.3."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
-- Bases de dados: conjuntos de ficheiros que se podem associar a conversas.
CREATE TABLE IF NOT EXISTS libraries (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL DEFAULT 'Nova conversa',
  pinned           INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  library_id       TEXT REFERENCES libraries(id) ON DELETE SET NULL
);

-- Cada documento é de uma conversa ou de uma base de dados (nunca dos dois).
CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  library_id      TEXT REFERENCES libraries(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  file_type       TEXT NOT NULL CHECK (file_type IN ('pdf','pptx','docx')),
  sha256          TEXT NOT NULL,
  n_chunks        INTEGER NOT NULL,
  stored_path     TEXT NOT NULL,
  uploaded_at     TEXT NOT NULL,
  CHECK ((conversation_id IS NULL) <> (library_id IS NULL))
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
CREATE INDEX IF NOT EXISTS idx_documents_lib ON documents(library_id);

-- Ferramentas de casos práticos: análise da estrutura de cada documento e a
-- resposta-modelo de um conjunto de documentos (para não repetir chamadas ao LLM).
CREATE TABLE IF NOT EXISTS doc_analyses (
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, kind)
);

CREATE TABLE IF NOT EXISTS model_answers (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  doc_key         TEXT NOT NULL,              -- ids dos documentos, ordenados, separados por vírgulas
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (conversation_id, doc_key)
);

-- Conversas onde cada base de dados já foi usada (perguntas feitas com ela associada).
-- Fica mesmo depois de a desassociar.
CREATE TABLE IF NOT EXISTS library_usage (
  library_id      TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_used_at    TEXT NOT NULL,
  PRIMARY KEY (library_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data_json  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"""

_initialized: set[str] = set()


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


_DOCUMENTS_NEW = """
    CREATE TABLE documents_new (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      library_id      TEXT REFERENCES libraries(id) ON DELETE CASCADE,
      filename        TEXT NOT NULL,
      file_type       TEXT NOT NULL CHECK (file_type IN ('pdf','pptx','docx')),
      sha256          TEXT NOT NULL,
      n_chunks        INTEGER NOT NULL,
      stored_path     TEXT NOT NULL,
      uploaded_at     TEXT NOT NULL,
      CHECK ((conversation_id IS NULL) <> (library_id IS NULL))
    )"""


def _rebuild_documents(conn: sqlite3.Connection, copy_columns: str, before=None) -> None:
    """Reconstrói `documents` com o esquema atual, copiando `copy_columns`.

    Corre com as chaves estrangeiras desligadas, senão o DROP apagaria as análises em cascata.
    """
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.execute("BEGIN")
        if before:
            before()
        conn.execute(_DOCUMENTS_NEW)
        conn.execute(f"INSERT INTO documents_new ({copy_columns}) SELECT {copy_columns} FROM documents")
        conn.execute("DROP TABLE documents")
        conn.execute("ALTER TABLE documents_new RENAME TO documents")
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def _migrate(conn: sqlite3.Connection) -> None:
    """Atualiza BDs criadas por versões anteriores.

    1. Antes das bases de dados: junta `library_id` às conversas e aos documentos
       (o `conversation_id` dos documentos deixa de ser obrigatório).
    2. Antes do .docx: o CHECK de `file_type` só aceitava 'pdf' e 'pptx'.
    """
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if "documents" not in tables:
        return
    if "library_id" not in _columns(conn, "documents"):
        def add_libraries():
            conn.execute("CREATE TABLE IF NOT EXISTS libraries (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)")
            if "library_id" not in _columns(conn, "conversations"):
                conn.execute("ALTER TABLE conversations ADD COLUMN library_id TEXT REFERENCES libraries(id) ON DELETE SET NULL")

        _rebuild_documents(
            conn, "id, conversation_id, filename, file_type, sha256, n_chunks, stored_path, uploaded_at", add_libraries)
    ddl = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'").fetchone()[0]
    if "'docx'" not in ddl:
        _rebuild_documents(
            conn, "id, conversation_id, library_id, filename, file_type, sha256, n_chunks, stored_path, uploaded_at")


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
            _migrate(conn)
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
