"""ChromaDB persistente com uma coleção por perfil (`docs_<perfil>`, cosseno)."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import chromadb


@lru_cache(maxsize=4)
def _client(path: str):
    Path(path).mkdir(parents=True, exist_ok=True)
    return chromadb.PersistentClient(
        path=path, settings=chromadb.Settings(anonymized_telemetry=False)
    )


class VectorStore:
    def __init__(self, chroma_dir: Path, profile: str):
        self.collection = _client(str(chroma_dir)).get_or_create_collection(
            name=f"docs_{profile}",
            metadata={"hnsw:space": "cosine"},
            embedding_function=None,
        )

    def add(self, ids, embeddings, documents, metadatas, batch: int = 256) -> None:
        for i in range(0, len(ids), batch):
            self.collection.add(
                ids=ids[i : i + batch],
                embeddings=embeddings[i : i + batch],
                documents=documents[i : i + batch],
                metadatas=metadatas[i : i + batch],
            )

    @staticmethod
    def _scope(scopes: str | list[str]) -> dict:
        """`scopes`: uma conversa, ou a conversa e a base de dados associada (ver Workspace.scopes)."""
        if isinstance(scopes, str) or len(scopes) == 1:
            return {"conversation_id": scopes if isinstance(scopes, str) else scopes[0]}
        return {"conversation_id": {"$in": list(scopes)}}

    def query(self, embedding, scopes: str | list[str], k: int, doc_ids: list[str] | None = None):
        where: dict = self._scope(scopes)
        if doc_ids:
            where = {"$and": [where, {"doc_id": {"$in": list(doc_ids)}}]}
        res = self.collection.query(
            query_embeddings=[embedding], n_results=k, where=where,
            include=["metadatas", "documents", "distances"],
        )
        hits = []
        for meta, doc, dist in zip(res["metadatas"][0], res["documents"][0], res["distances"][0]):
            hits.append({**meta, "chunk_text": meta.get("chunk_text") or doc, "score": 1.0 - dist})
        return hits

    def all_chunks(self, scopes: str | list[str], doc_ids: list[str] | None = None) -> list[dict]:
        """Todos os blocos da conversa (sem ordem garantida), para perguntas sobre o documento inteiro."""
        where: dict = self._scope(scopes)
        if doc_ids:
            where = {"$and": [where, {"doc_id": {"$in": list(doc_ids)}}]}
        res = self.collection.get(where=where, include=["metadatas", "documents"])
        return [
            {**meta, "chunk_text": meta.get("chunk_text") or doc}
            for meta, doc in zip(res["metadatas"] or [], res["documents"] or [])
        ]

    def delete_where(self, **filters) -> None:
        self.collection.delete(where=filters if len(filters) == 1 else {"$and": [{k: v} for k, v in filters.items()]})

    def count(self, **filters) -> int:
        if not filters:
            return self.collection.count()
        where = filters if len(filters) == 1 else {"$and": [{k: v} for k, v in filters.items()]}
        return len(self.collection.get(where=where, include=[])["ids"])

    def all_doc_ids(self) -> set[str]:
        metas = self.collection.get(include=["metadatas"])["metadatas"] or []
        return {m["doc_id"] for m in metas if m and "doc_id" in m}
