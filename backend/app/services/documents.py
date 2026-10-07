"""Upload e indexação de documentos dentro de uma conversa (blueprint 4)."""
from __future__ import annotations

import hashlib
import uuid
import zipfile
from pathlib import Path

from ..core.db import connect, utcnow
from .chunking import ParseResult, normalize
from .embeddings import Embedder
from .ingest_pdf import parse_pdf
from .ingest_ppt import parse_pptx
from .workspace import Workspace


class IngestError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def _detect_type(filename: str, head: bytes) -> str:
    ext = Path(filename).suffix.lower()
    if ext not in {".pdf", ".pptx"}:
        raise IngestError("Só são aceites ficheiros .pdf e .pptx.", 415)
    if head.startswith(b"\xd0\xcf\x11\xe0"):
        raise IngestError("O ficheiro está protegido por palavra-passe (ou é um .ppt antigo).", 400)
    if ext == ".pdf" and not head.lstrip()[:5].startswith(b"%PDF-"):
        raise IngestError("O conteúdo não é um PDF válido.", 415)
    if ext == ".pptx" and not head.startswith(b"PK\x03\x04"):
        raise IngestError("O conteúdo não é um PPTX válido.", 415)
    return ext[1:]


def list_documents(ws: Workspace, conversation_id: str) -> list[dict]:
    with connect(ws.db_path) as db:
        rows = db.execute(
            "SELECT id, filename, file_type, n_chunks, uploaded_at FROM documents"
            " WHERE conversation_id=? ORDER BY uploaded_at", (conversation_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def ingest(ws: Workspace, embedder: Embedder, conversation_id: str, filename: str, data: bytes) -> dict:
    s = ws.settings
    filename = Path(filename or "documento").name[:200]
    if len(data) == 0:
        raise IngestError("O ficheiro está vazio.")
    if len(data) > s.max_file_mb * 1024 * 1024:
        raise IngestError(f"O ficheiro excede {s.max_file_mb} MB.", 413)
    file_type = _detect_type(filename, data[:1024])
    sha = hashlib.sha256(data).hexdigest()

    with connect(ws.db_path) as db:
        existing = db.execute(
            "SELECT id, filename FROM documents WHERE conversation_id=? AND sha256=?", (conversation_id, sha)
        ).fetchone()
        n_docs = db.execute(
            "SELECT COUNT(*) FROM documents WHERE conversation_id=?", (conversation_id,)
        ).fetchone()[0]
    if existing:
        return {"duplicate": True, "doc_id": existing["id"], "filename": existing["filename"],
                "warnings": [f"Este ficheiro já foi carregado nesta conversa ({existing['filename']}); não foi reindexado."]}
    if n_docs >= s.max_files_per_conversation:
        raise IngestError(f"Máximo de {s.max_files_per_conversation} ficheiros por conversa.", 409)

    doc_id = str(uuid.uuid4())
    conv_dir = ws.conversation_dir(conversation_id)
    conv_dir.mkdir(parents=True, exist_ok=True)
    stored = conv_dir / f"{doc_id}.{file_type}"
    stored.write_bytes(data)

    try:
        parsed = _parse(stored, file_type, s)
        if not parsed.chunks:
            raise IngestError("Não foi possível extrair texto do ficheiro (digitalizado ou só imagens?).", 422)
        texts = [normalize(c.text) for c in parsed.chunks]
        vectors = embedder.embed_documents(texts)
        metadatas = []
        for c, text in zip(parsed.chunks, texts):
            m = {
                "source": filename, "file_type": file_type, "page_number": c.page_number,
                "section_title": c.section_title or "", "chunk_text": text,
                "doc_id": doc_id, "conversation_id": conversation_id,
            }
            if c.page_end:
                m["page_end"] = c.page_end
            metadatas.append(m)
        ws.vectors.add(
            ids=[f"{doc_id}:{i}" for i in range(len(texts))],
            embeddings=vectors, documents=texts, metadatas=metadatas,
        )
        with connect(ws.db_path) as db:
            db.execute(
                "INSERT INTO documents (id, conversation_id, filename, file_type, sha256, n_chunks, stored_path, uploaded_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (doc_id, conversation_id, filename, file_type, sha, len(texts),
                 str(stored.relative_to(ws.root)), utcnow()),
            )
    except BaseException as exc:
        # Falha a meio: não deixar vetores nem ficheiro (blueprint 4).
        try:
            ws.vectors.delete_where(doc_id=doc_id)
        finally:
            stored.unlink(missing_ok=True)
        if isinstance(exc, IngestError):
            raise
        if isinstance(exc, (ValueError, zipfile.BadZipFile, KeyError)):
            raise IngestError(f"Não foi possível ler o ficheiro: {exc}", 422) from exc
        raise

    units = "slides" if file_type == "pptx" else "páginas"
    return {
        "duplicate": False, "doc_id": doc_id, "filename": filename, "file_type": file_type,
        "n_chunks": len(texts), "skipped": parsed.skipped_units, "skipped_kind": units,
        "warnings": parsed.warnings,
    }


def _parse(path: Path, file_type: str, s) -> ParseResult:
    if file_type == "pptx":
        return parse_pptx(path, max_tokens=s.slide_max_tokens, include_notes=s.include_speaker_notes)
    try:
        return parse_pdf(path, parser=s.pdf_parser, max_tokens=s.pdf_chunk_tokens, overlap=s.pdf_chunk_overlap)
    except RuntimeError as exc:  # PyMuPDF: ficheiro corrompido
        raise IngestError(f"PDF inválido ou corrompido: {exc}", 422) from exc


def delete_document(ws: Workspace, conversation_id: str, doc_id: str) -> bool:
    with connect(ws.db_path) as db:
        row = db.execute(
            "SELECT stored_path FROM documents WHERE id=? AND conversation_id=?", (doc_id, conversation_id)
        ).fetchone()
    if not row:
        return False
    ws.vectors.delete_where(doc_id=doc_id)
    (ws.root / row["stored_path"]).unlink(missing_ok=True)
    with connect(ws.db_path) as db:
        db.execute("DELETE FROM documents WHERE id=?", (doc_id,))
    return True


def valid_doc_ids(ws: Workspace, conversation_id: str, doc_ids: list[str]) -> list[str]:
    known = {d["id"] for d in list_documents(ws, conversation_id)}
    return [d for d in doc_ids if d in known]
