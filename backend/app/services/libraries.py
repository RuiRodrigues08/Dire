"""Bases de dados: conjuntos de ficheiros do perfil que se associam a conversas.

Os ficheiros indexam-se uma vez (âmbito `lib:<id>` nos vetores) e servem todas as
conversas associadas; apagar a base desliga-a dessas conversas.
"""
from __future__ import annotations

import shutil
import uuid

from ..core.db import connect, utcnow
from .workspace import Workspace, library_scope

NAME_MAX = 60


class LibraryError(ValueError):
    pass


def _clean_name(name: str | None) -> str:
    n = " ".join((name or "").split())[:NAME_MAX]
    if not n:
        raise LibraryError("A base de dados precisa de um nome.")
    return n


_SELECT = """
SELECT l.id, l.name, l.created_at,
       (SELECT COUNT(*) FROM documents d WHERE d.library_id = l.id) AS n_documents,
       (SELECT COALESCE(SUM(n_chunks), 0) FROM documents d WHERE d.library_id = l.id) AS n_chunks,
       (SELECT COUNT(*) FROM conversations c WHERE c.library_id = l.id) AS n_conversations
FROM libraries l
"""


def record_use(ws: Workspace, conversation_id: str) -> None:
    """Regista que a conversa fez uma pergunta com a sua base associada (se tiver uma)."""
    with connect(ws.db_path) as db:
        row = db.execute("SELECT library_id FROM conversations WHERE id=?", (conversation_id,)).fetchone()
        if row and row["library_id"]:
            db.execute(
                "INSERT INTO library_usage (library_id, conversation_id, last_used_at) VALUES (?,?,?)"
                " ON CONFLICT(library_id, conversation_id) DO UPDATE SET last_used_at=excluded.last_used_at",
                (row["library_id"], conversation_id, utcnow()),
            )


def _usage(db, library_id: str) -> dict:
    """Conversas associadas à base (agora) e conversas onde ela já foi usada, estejam ou não
    associadas ainda: perguntas feitas com ela associada (library_usage) e respostas com fontes
    de ficheiros dela (cobre também o que foi feito antes de existir o registo)."""
    associated = db.execute(
        "SELECT id, title FROM conversations WHERE library_id=? ORDER BY last_activity_at DESC", (library_id,)
    ).fetchall()
    doc_ids = [r["id"] for r in db.execute("SELECT id FROM documents WHERE library_id=?", (library_id,))]
    used: dict[str, dict] = {
        r["id"]: dict(r) for r in db.execute(
            "SELECT c.id, c.title, c.last_activity_at FROM library_usage u JOIN conversations c ON c.id = u.conversation_id"
            " WHERE u.library_id=?", (library_id,))
    }
    for doc_id in doc_ids:
        for r in db.execute(
            "SELECT DISTINCT c.id, c.title, c.last_activity_at FROM conversations c JOIN messages m ON m.conversation_id = c.id"
            " WHERE m.role='assistant' AND m.sources_json LIKE ?", (f'%"{doc_id}"%',)
        ):
            used[r["id"]] = dict(r)
    used_list = sorted(used.values(), key=lambda r: r["last_activity_at"], reverse=True)
    return {
        "associated": [dict(r) for r in associated],
        "used": [{"id": r["id"], "title": r["title"]} for r in used_list],
    }


def list_all(ws: Workspace) -> list[dict]:
    with connect(ws.db_path) as db:
        rows = db.execute(_SELECT + " ORDER BY l.name COLLATE NOCASE").fetchall()
        return [{**dict(r), **_usage(db, r["id"])} for r in rows]


def get(ws: Workspace, library_id: str) -> dict | None:
    with connect(ws.db_path) as db:
        row = db.execute(_SELECT + " WHERE l.id=?", (library_id,)).fetchone()
        return {**dict(row), **_usage(db, library_id)} if row else None


def search(ws: Workspace, embedder, library_id: str, query: str, k: int = 8) -> list[dict]:
    """Pesquisa no conteúdo dos ficheiros da base (por significado), mais os nomes que coincidem."""
    q = query.strip()
    hits = ws.vectors.query(embedder.embed_query(q), library_scope(library_id), k) if q else []
    out, seen = [], set()
    for h in hits:
        key = (h["doc_id"], h["page_number"])
        if key in seen:
            continue
        seen.add(key)
        text = " ".join((h.get("chunk_text") or "").split())
        out.append({
            "doc_id": h["doc_id"], "filename": h["source"], "file_type": h.get("file_type"),
            "page_number": h["page_number"], "snippet": text[:240] + ("…" if len(text) > 240 else ""),
            "score": round(h["score"], 3),
        })
    return out


def create(ws: Workspace, name: str) -> dict:
    lid = str(uuid.uuid4())
    with connect(ws.db_path) as db:
        db.execute("INSERT INTO libraries (id, name, created_at) VALUES (?,?,?)", (lid, _clean_name(name), utcnow()))
    return get(ws, lid)


def rename(ws: Workspace, library_id: str, name: str) -> dict | None:
    with connect(ws.db_path) as db:
        db.execute("UPDATE libraries SET name=? WHERE id=?", (_clean_name(name), library_id))
    return get(ws, library_id)


def delete(ws: Workspace, library_id: str) -> bool:
    if get(ws, library_id) is None:
        return False
    ws.vectors.delete_where(conversation_id=library_scope(library_id))
    shutil.rmtree(ws.library_dir(library_id), ignore_errors=True)
    with connect(ws.db_path) as db:
        # documentos em cascata; as conversas associadas ficam sem base (ON DELETE SET NULL)
        db.execute("DELETE FROM libraries WHERE id=?", (library_id,))
    return True
