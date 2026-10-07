"""CRUD de conversas, apagar em cascata, limpeza automática e reconciliação."""
from __future__ import annotations

import json
import shutil
import uuid
from datetime import datetime, timedelta, timezone

from ..core.db import connect, parse_ts, utcnow
from .workspace import Workspace

DEFAULT_TITLE = "Nova conversa"
TITLE_MAX = 60


def _days_left(row, retention_days: int) -> int | None:
    if row["pinned"]:
        return None
    deadline = parse_ts(row["last_activity_at"]) + timedelta(days=retention_days)
    return max(0, (deadline - datetime.now(timezone.utc)).days)


def _conv_dict(row, retention_days: int) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "pinned": bool(row["pinned"]),
        "created_at": row["created_at"],
        "last_activity_at": row["last_activity_at"],
        "days_until_deletion": _days_left(row, retention_days),
    }


def create(ws: Workspace, title: str | None = None) -> dict:
    now = utcnow()
    cid = str(uuid.uuid4())
    with connect(ws.db_path) as db:
        db.execute(
            "INSERT INTO conversations (id, title, pinned, created_at, last_activity_at) VALUES (?,?,0,?,?)",
            (cid, (title or DEFAULT_TITLE)[:TITLE_MAX], now, now),
        )
        row = db.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
    return _conv_dict(row, ws.settings.chat_retention_days)


def list_all(ws: Workspace) -> list[dict]:
    with connect(ws.db_path) as db:
        rows = db.execute(
            "SELECT * FROM conversations ORDER BY pinned DESC, last_activity_at DESC"
        ).fetchall()
    return [_conv_dict(r, ws.settings.chat_retention_days) for r in rows]


def get(ws: Workspace, conversation_id: str) -> dict | None:
    with connect(ws.db_path) as db:
        row = db.execute("SELECT * FROM conversations WHERE id=?", (conversation_id,)).fetchone()
    return _conv_dict(row, ws.settings.chat_retention_days) if row else None


def update(ws: Workspace, conversation_id: str, title: str | None = None, pinned: bool | None = None) -> dict | None:
    with connect(ws.db_path) as db:
        if title is not None:
            db.execute("UPDATE conversations SET title=? WHERE id=?", (title.strip()[:TITLE_MAX] or DEFAULT_TITLE, conversation_id))
        if pinned is not None:
            db.execute("UPDATE conversations SET pinned=? WHERE id=?", (int(pinned), conversation_id))
    return get(ws, conversation_id)


def delete(ws: Workspace, conversation_id: str) -> bool:
    """Ordem obrigatória (7.2): vetores, ficheiros, linha (documentos e mensagens em cascata)."""
    if get(ws, conversation_id) is None:
        return False
    ws.vectors.delete_where(conversation_id=conversation_id)
    shutil.rmtree(ws.conversation_dir(conversation_id), ignore_errors=True)
    with connect(ws.db_path) as db:
        db.execute("DELETE FROM conversations WHERE id=?", (conversation_id,))
    return True


def delete_all(ws: Workspace) -> int:
    ids = [c["id"] for c in list_all(ws)]
    for cid in ids:
        delete(ws, cid)
    return len(ids)


# ---------- mensagens ----------

def messages(ws: Workspace, conversation_id: str) -> list[dict]:
    with connect(ws.db_path) as db:
        rows = db.execute(
            "SELECT * FROM messages WHERE conversation_id=? ORDER BY id", (conversation_id,)
        ).fetchall()
    return [
        {
            "id": r["id"], "role": r["role"], "content": r["content"],
            "sources": json.loads(r["sources_json"]) if r["sources_json"] else None,
            "prompt_tokens": r["prompt_tokens"], "gen_tokens": r["gen_tokens"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def recent_history(ws: Workspace, conversation_id: str, turns: int) -> list[dict]:
    """Últimas `turns` trocas (pergunta + resposta), da mais antiga para a mais recente."""
    with connect(ws.db_path) as db:
        rows = db.execute(
            "SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?",
            (conversation_id, turns * 2),
        ).fetchall()
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


def save_exchange(ws: Workspace, conversation_id: str, query: str, answer: str,
                  sources: list[dict], prompt_tokens: int, gen_tokens: int) -> None:
    now = utcnow()
    with connect(ws.db_path) as db:
        db.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?,?,?,?)",
            (conversation_id, "user", query, now),
        )
        db.execute(
            "INSERT INTO messages (conversation_id, role, content, sources_json, prompt_tokens, gen_tokens, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (conversation_id, "assistant", answer, json.dumps(sources, ensure_ascii=False), prompt_tokens, gen_tokens, now),
        )
        # Só enviar mensagens conta como uso (7.3). Título automático na 1.ª pergunta.
        db.execute("UPDATE conversations SET last_activity_at=? WHERE id=?", (now, conversation_id))
        db.execute(
            "UPDATE conversations SET title=? WHERE id=? AND title=?",
            (_auto_title(query), conversation_id, DEFAULT_TITLE),
        )


def _auto_title(query: str) -> str:
    q = " ".join(query.split())
    return q if len(q) <= TITLE_MAX else q[: TITLE_MAX - 1].rstrip() + "…"


# ---------- limpeza e reconciliação ----------

def cleanup_expired(ws: Workspace) -> list[str]:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=ws.settings.chat_retention_days)).isoformat(timespec="seconds")
    with connect(ws.db_path) as db:
        ids = [r["id"] for r in db.execute(
            "SELECT id FROM conversations WHERE pinned=0 AND last_activity_at < ?", (cutoff,)
        ).fetchall()]
    for cid in ids:
        delete(ws, cid)
    return ids


def reconcile(ws: Workspace) -> dict:
    """Remove vetores sem documento e pastas de uploads sem conversa (ou ficheiros sem documento)."""
    with connect(ws.db_path) as db:
        doc_rows = db.execute("SELECT id, conversation_id, stored_path FROM documents").fetchall()
        conv_ids = {r["id"] for r in db.execute("SELECT id FROM conversations").fetchall()}
    known_docs = {r["id"] for r in doc_rows}
    known_files = {r["stored_path"] for r in doc_rows}

    orphan_vectors = ws.vectors.all_doc_ids() - known_docs
    for doc_id in orphan_vectors:
        ws.vectors.delete_where(doc_id=doc_id)

    removed_paths: list[str] = []
    if ws.uploads_dir.is_dir():
        for conv_dir in ws.uploads_dir.iterdir():
            if not conv_dir.is_dir() or conv_dir.name not in conv_ids:
                shutil.rmtree(conv_dir, ignore_errors=True) if conv_dir.is_dir() else conv_dir.unlink(missing_ok=True)
                removed_paths.append(str(conv_dir))
                continue
            for f in conv_dir.iterdir():
                rel = str(f.relative_to(ws.root))
                if rel not in known_files:
                    f.unlink(missing_ok=True)
                    removed_paths.append(rel)
    return {"orphan_vectors": sorted(orphan_vectors), "removed_paths": removed_paths}
