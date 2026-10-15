"""Search primitives for the Ave Local Indexer worker.

- ``search_bm25``: Kiwi tokenise query, MATCH against ``chunks_fts``,
  order by ``bm25(chunks_fts)`` ascending (lower = better) and expose a
  normalised ``score`` (higher = better) so that callers can merge with
  vector scores in Reciprocal Rank Fusion.
- ``search_vector``: embed query with ``OpenAIEmbeddingClient``, then
  call the injected ``LanceVectorStore``/duck-typed store. The store
  searches with the ``cosine`` metric and normalises each ``_distance``
  to ``score = 1 / (1 + cosine_distance)`` so that higher = better,
  matching the BM25 polarity before Reciprocal Rank Fusion.
- ``search_hybrid_internal``: worker-side RRF with k=60, used as a
  TypeScript fallback.
- ``get_document_structure`` / ``get_page_content``: read the document
  outline and page text directly from the indexed SQLite store.

The search layer never owns its own connection pool; callers pass in
(or the helper lazily opens) a read-only SQLite connection per query.
"""

from __future__ import annotations

import logging
import math
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence

try:  # pragma: no cover - optional
    import structlog  # type: ignore

    log = structlog.get_logger(__name__)
except Exception:  # pragma: no cover
    log = logging.getLogger(__name__)


RRF_K = 60

# Default per-source weights for RRF fusion. Callers may override via
# :class:`RetrieverConfig` or by passing ``rrf_weights`` to the helper.
DEFAULT_RRF_WEIGHTS: Dict[str, float] = {
    "bm25": 1.5,
    "vector": 1.0,
}


@dataclass
class RetrieverConfig:
    """Hybrid retriever configuration (BM25 + vector RRF weighting).

    ``rrf_weights`` is a mapping of source label → multiplier applied
    to each source's RRF contribution. Keys not present fall back to
    ``1.0``. ``k`` controls the RRF constant (default 60).
    """

    k: int = RRF_K
    rrf_weights: Dict[str, float] = field(
        default_factory=lambda: dict(DEFAULT_RRF_WEIGHTS)
    )


@dataclass
class SearchHit:
    chunk_id: str
    doc_id: str
    doc_name: str
    page: Optional[int]
    raw_text: str
    # Higher = better. bm25: |bm25|/(1+|bm25|); vector: 1/(1+cosine_distance).
    score: float
    source: str
    path: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "doc_id": self.doc_id,
            "doc_name": self.doc_name,
            "page": self.page,
            "raw_text": self.raw_text,
            "score": self.score,
            "source": self.source,
            "path": self.path,
        }


class SearchService:
    def __init__(
        self,
        sqlite_path: str,
        *,
        tokenizer: Any = None,
        embedding_client: Any = None,
        vector_store: Any = None,
        retriever_config: Optional[RetrieverConfig] = None,
        lance_path: Optional[str] = None,
        embedding_provider: str = "openai",
        embedding_model: str = "text-embedding-3-small",
        openai_api_key: Optional[str] = None,
        embedding_dimensions: Optional[int] = None,
        embedding_endpoint: str = "",
        embedding_api_version: str = "",
        egress_broker_url: str = "",
        egress_broker_uds: str = "",
    ) -> None:
        self.sqlite_path = sqlite_path
        # Egress broker (P3 ⑬): query-time vector search routes its embedding
        # call through the broker too, holding only the session token.
        self._egress_broker_base = (egress_broker_url or "").rstrip("/")
        # The socket the broker actually listens on. The base above is only an
        # authority the provider SDKs insist on parsing; nothing dials it.
        self._egress_broker_uds = egress_broker_uds or ""
        self._tokenizer = tokenizer
        self._embedding_client = embedding_client
        self._vector_store = vector_store
        self.retriever_config = retriever_config or RetrieverConfig()
        self.lance_path = lance_path
        self.embedding_provider = embedding_provider
        self.embedding_model = embedding_model
        self._openai_api_key = openai_api_key
        self.embedding_dimensions = embedding_dimensions
        # Optional OpenAI-compatible / Azure OpenAI endpoint URL. Mandatory
        # for provider=="azure", optional override for "openai".
        self.embedding_endpoint = embedding_endpoint or ""
        self.embedding_api_version = embedding_api_version or ""

    def close(self) -> None:
        """Release cached vector/SQLite handles before worker shutdown."""
        store = self._vector_store
        self._vector_store = None
        if store is not None:
            close = getattr(store, "close", None)
            if callable(close):
                close()

        conn = self._open_ro()
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()

    @property
    def egress_brokered(self) -> bool:
        return bool(self._egress_broker_base)

    @property
    def egress_embedding_url(self) -> str:
        return f"{self._egress_broker_base}/egress/embedding" if self._egress_broker_base else ""

    # ------------------------------------------------------------------
    # Runtime key lifecycle
    # ------------------------------------------------------------------
    def set_embedding_api_key(self, api_key: str) -> None:
        """Install the embedding API key pushed by the host at runtime.

        The env key channel was removed, so the *search* path now receives
        its credential exclusively through this setter (mirroring
        ``LocalIndexer.set_embedding_api_key``). Without it, query-time vector
        search — which runs outside any index_scan window — would boot with an
        empty key and silently degrade to BM25-only.

        Resets the cached ``_embedding_client`` so the next ``search_vector``
        call rebuilds it with the new key.
        """
        if not isinstance(api_key, str) or not api_key:
            return
        self._openai_api_key = api_key
        # Invalidate the lazy client so _get_embedding_client rebuilds with the
        # new key on the next vector search.
        self._embedding_client = None

    def clear_embedding_key(self) -> None:
        """Drop the embedding key reference (shutdown / rotation).

        Best-effort: rebinds our attribute and nulls the cached client.
        Python string immutability means the original bytes are NOT zeroed
        in place; copies held inside the OpenAI SDK object are released only
        when _embedding_client is set to None. Do not rely on this as a
        secure-erase. Called on /shutdown — NOT at scan end — so the key
        stays resident while search can still run.
        """
        if isinstance(self._openai_api_key, str) and self._openai_api_key:
            self._openai_api_key = "\x00" * len(self._openai_api_key)
        self._openai_api_key = None
        self._embedding_client = None

    # ------------------------------------------------------------------
    # BM25
    # ------------------------------------------------------------------
    def search_bm25(self, query: str, top_k: int = 20) -> List[Dict[str, Any]]:
        if not query or not query.strip():
            return []

        # Pass 0: exact raw_text match — handles proper nouns / names where
        # morpheme tokenization drops honorifics (e.g. "박선임님" → ["박","선임"],
        # 님/XSN dropped).  Exact hits are prepended before FTS results.
        exact_hits = self._exact_match_query(query.strip(), top_k)
        exact_ids = {h["chunk_id"] for h in exact_hits}

        tokenizer = self._get_tokenizer()
        tokens = [t for t in tokenizer.tokenize_query(query).split() if t]
        if not tokens:
            return exact_hits[:top_k]

        # Pass 1: AND — 모든 토큰을 포함한 chunk만 반환 (high-precision)
        and_expr = " AND ".join(_escape_fts(t) for t in tokens)
        fts_hits = self._fts_query(and_expr, top_k)
        if not fts_hits:
            # Pass 2: OR fallback (recall 우선)
            or_expr = " OR ".join(_escape_fts(t) for t in tokens)
            fts_hits = self._fts_query(or_expr, top_k)

        # Merge: exact hits first (dedup by chunk_id)
        merged = list(exact_hits)
        for h in fts_hits:
            if h["chunk_id"] not in exact_ids:
                merged.append(h)
        return merged[:top_k]

    def _fts_query(self, fts_expr: str, top_k: int) -> List[Dict[str, Any]]:
        conn = self._open_ro()
        try:
            rows = conn.execute(
                """
                SELECT chunks_fts.chunk_id   AS chunk_id,
                       chunks_fts.doc_id     AS doc_id,
                       chunks_fts.raw_text   AS raw_text,
                       documents.doc_name    AS doc_name,
                       documents.path        AS doc_path,
                       chunks.page           AS page,
                       bm25(chunks_fts)      AS bm25
                FROM chunks_fts
                JOIN chunks    ON chunks.chunk_id = chunks_fts.chunk_id
                JOIN documents ON documents.doc_id = chunks_fts.doc_id
                WHERE chunks_fts MATCH ?
                ORDER BY bm25 ASC
                LIMIT ?
                """,
                (fts_expr, top_k),
            ).fetchall()
        finally:
            conn.close()
        hits: List[SearchHit] = []
        for row in rows:
            bm25 = row["bm25"]
            # FTS5 bm25() returns negative values; more negative = better match.
            # Normalize to [0,1] where higher score = better: |bm25| / (1 + |bm25|).
            neg = max(0.0, -float(bm25)) if bm25 is not None else 0.0
            score = neg / (1.0 + neg) if bm25 is not None else 0.0
            hits.append(
                SearchHit(
                    chunk_id=row["chunk_id"],
                    doc_id=row["doc_id"],
                    doc_name=row["doc_name"],
                    page=row["page"],
                    raw_text=row["raw_text"],
                    score=score,
                    source="bm25",
                    path=row["doc_path"],
                )
            )
        return [h.to_dict() for h in hits]

    _EXACT_MATCH_MAX_LEN = 128

    def _exact_match_query(self, query: str, top_k: int) -> List[Dict[str, Any]]:
        """LIKE-based exact substring match against raw_text.

        Used as a pre-pass before FTS tokenization so that proper nouns and
        names with honorifics (e.g. "박선임님") are found even when morpheme
        tokenization drops suffix tokens like 님/XSN.

        Queries shorter than 2 chars or longer than _EXACT_MATCH_MAX_LEN chars
        are skipped — too-short queries match nearly every chunk (full scan
        flood), too-long patterns pose a DoS risk.
        """
        if len(query) < 2 or len(query) > self._EXACT_MATCH_MAX_LEN:
            return []
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conn = self._open_ro()
        try:
            rows = conn.execute(
                """
                SELECT c.chunk_id, c.doc_id, c.raw_text, c.page,
                       d.doc_name, d.path AS doc_path
                FROM chunks c
                JOIN documents d ON d.doc_id = c.doc_id
                WHERE c.raw_text LIKE ? ESCAPE '\\'
                LIMIT ?
                """,
                (f"%{escaped}%", top_k),
            ).fetchall()
        finally:
            conn.close()
        return [
            SearchHit(
                chunk_id=row["chunk_id"],
                doc_id=row["doc_id"],
                doc_name=row["doc_name"],
                page=row["page"],
                raw_text=row["raw_text"],
                score=0.9,  # slightly below FTS AND-match ceiling to allow BM25 ranking
                source="exact",
                path=row["doc_path"],
            ).to_dict()
            for row in rows
        ]

    # ------------------------------------------------------------------
    # Vector
    # ------------------------------------------------------------------
    def search_vector(self, query: str, top_k: int = 20) -> List[Dict[str, Any]]:
        if not query or not query.strip():
            return []
        embedding_client = self._get_embedding_client()
        vector_store = self._get_vector_store()
        if embedding_client is None or vector_store is None:
            log.info("search.vector.skipped", reason="missing client/store")
            return []
        vector = embedding_client.embed_one(query)
        if not vector:
            return []
        results = vector_store.search(vector, top_k=top_k) or []
        conn = self._open_ro()
        try:
            hits: List[SearchHit] = []
            for item in results:
                chunk_id = item.get("chunk_id")
                if not chunk_id:
                    continue
                row = conn.execute(
                    """
                    SELECT chunks.chunk_id, chunks.doc_id, chunks.raw_text, chunks.page,
                           documents.doc_name, documents.path AS doc_path
                    FROM chunks
                    JOIN documents ON documents.doc_id = chunks.doc_id
                    WHERE chunks.chunk_id = ?
                    """,
                    (chunk_id,),
                ).fetchone()
                if not row:
                    continue
                hits.append(
                    SearchHit(
                        chunk_id=row["chunk_id"],
                        doc_id=row["doc_id"],
                        doc_name=row["doc_name"],
                        page=row["page"],
                        raw_text=row["raw_text"],
                        score=float(item.get("score", 0.0)),
                        source="vector",
                        path=row["doc_path"],
                    )
                )
        finally:
            conn.close()
        return [h.to_dict() for h in hits]

    # ------------------------------------------------------------------
    # Hybrid (worker-side fallback)
    # ------------------------------------------------------------------
    def search_hybrid_internal(
        self, query: str, top_k: int = 20
    ) -> List[Dict[str, Any]]:
        bm = self.search_bm25(query, top_k=top_k)
        try:
            vec = self.search_vector(query, top_k=top_k)
        except Exception as exc:
            # Graceful degradation: vector search unavailable (e.g. embedding
            # API blocked by corporate DLP/firewall). Fall back to BM25 only.
            import logging
            logging.getLogger(__name__).warning(
                "Vector search unavailable, using BM25 only: %s", exc
            )
            return bm[:top_k]
        cfg = self.retriever_config
        fused = _reciprocal_rank_fusion([bm, vec], k=cfg.k, rrf_weights=cfg.rrf_weights)
        return fused[:top_k]

    # ------------------------------------------------------------------
    # Agentic helpers
    # ------------------------------------------------------------------
    def get_document_structure(self, doc_id: str) -> Any:
        return self._get_structure_from_sqlite(doc_id)

    def get_page_content(self, doc_id: str, pages: str) -> Any:
        return self._get_page_content_from_sqlite(doc_id, pages)

    def _get_structure_from_sqlite(self, doc_id: str) -> Dict[str, Any]:
        conn = self._open_ro()
        try:
            doc_row = conn.execute(
                "SELECT doc_id, doc_name, doc_type, page_count, line_count FROM documents WHERE doc_id = ?",
                (doc_id,),
            ).fetchone()
            if not doc_row:
                return {"error": f"document {doc_id} not found"}
            page_rows = conn.execute(
                "SELECT DISTINCT page FROM chunks WHERE doc_id = ? AND page IS NOT NULL ORDER BY page",
                (doc_id,),
            ).fetchall()
        finally:
            conn.close()
        return {
            "doc_id": doc_row["doc_id"],
            "doc_name": doc_row["doc_name"],
            "doc_type": doc_row["doc_type"],
            "page_count": doc_row["page_count"],
            "line_count": doc_row["line_count"],
            "pages": [r["page"] for r in page_rows],
        }

    def _get_page_content_from_sqlite(
        self, doc_id: str, pages: str
    ) -> List[Dict[str, Any]]:
        page_numbers = _parse_page_numbers(pages)
        conn = self._open_ro()
        try:
            if page_numbers:
                placeholders = ",".join("?" * len(page_numbers))
                rows = conn.execute(
                    f"SELECT page, chunk_index, raw_text FROM chunks"
                    f" WHERE doc_id = ? AND COALESCE(page, 1) IN ({placeholders})"
                    f" ORDER BY page, chunk_index",
                    (doc_id, *page_numbers),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT page, chunk_index, raw_text FROM chunks"
                    " WHERE doc_id = ? ORDER BY COALESCE(page, 1), chunk_index",
                    (doc_id,),
                ).fetchall()
        finally:
            conn.close()
        grouped: Dict[int, List[str]] = {}
        for row in rows:
            pg = row["page"] if row["page"] is not None else 1
            grouped.setdefault(pg, []).append(row["raw_text"])
        return [
            {"page": pg, "content": " ".join(texts)}
            for pg, texts in sorted(grouped.items())
        ]

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _open_ro(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.sqlite_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _get_tokenizer(self) -> Any:
        if self._tokenizer is not None:
            return self._tokenizer
        from korean_tokenizer import get_tokenizer  # type: ignore

        self._tokenizer = get_tokenizer()
        return self._tokenizer

    def _get_embedding_client(self) -> Any:
        if self._embedding_client is not None:
            return self._embedding_client
        if self.egress_brokered:
            # Broker mode: the credential is the per-session token (in
            # _openai_api_key, pushed via /indexer/set_egress_token).
            if not self._openai_api_key:
                return None
        elif self.embedding_provider == "openai" and not self._openai_api_key:
            return None
        elif self.embedding_provider == "azure" and (
            not self.embedding_endpoint or not self._openai_api_key
        ):
            return None
        try:
            from embedding_client import create_embedding_client  # type: ignore

            client = create_embedding_client(
                provider=self.embedding_provider,
                model=self.embedding_model,
                api_key=None if self.egress_brokered else self._openai_api_key,
                endpoint=None if self.egress_brokered else (self.embedding_endpoint or None),
                api_version=self.embedding_api_version or None,
                dimensions=self.embedding_dimensions,
                target_rpm=400,
                egress_broker_url=self.egress_embedding_url or None,
                egress_broker_uds=self._egress_broker_uds or None,
                egress_token=self._openai_api_key if self.egress_brokered else None,
            )
            self._embedding_client = client
            return client
        except ValueError:
            # Unsupported provider — config-contract violation, not a runtime
            # condition. Surface it rather than masking it as BM25-only.
            try:
                log.exception(
                    "search.embedding_client.config_error",
                    provider=self.embedding_provider,
                )
            except TypeError:  # stdlib logging rejects structlog-style kwargs
                log.exception(
                    "search.embedding_client.config_error provider=%s",
                    self.embedding_provider,
                )
            raise
        except Exception as exc:
            log.info("search.embedding_client.unavailable", error=str(exc))
            return None

    def _get_vector_store(self) -> Any:
        if self._vector_store is not None:
            return self._vector_store
        if not self.lance_path:
            return None
        try:
            from local_indexer import create_lance_vector_store  # type: ignore

            # Ensure embedding client is initialized first so its .dimensions
            # attribute is available for accurate dimension resolution.
            client = self._get_embedding_client()
            dimensions = (
                int(client.dimensions)
                if client is not None
                else (
                    int(self.embedding_dimensions)
                    if self.embedding_dimensions
                    else 1536
                )
            )
            self._vector_store = create_lance_vector_store(
                self.lance_path, dimensions=dimensions
            )
            return self._vector_store
        except Exception as exc:
            log.info("search.vector_store.unavailable", error=str(exc))
            return None


# ----------------------------------------------------------------------
# Module helpers
# ----------------------------------------------------------------------
def _escape_fts(token: str) -> str:
    """Quote a token for safe FTS5 MATCH usage."""
    safe = token.replace('"', '""')
    return f'"{safe}"'


_MAX_PAGE_RANGE = 500
_MAX_TOTAL_PAGES = 1000


def _parse_page_numbers(pages: str) -> List[int]:
    """Parse a page expression like "1", "1-3", "1,3,5", "1-3,5,7-9" into a list of ints."""
    result: List[int] = []
    for part in pages.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            bounds = part.split("-", 1)
            try:
                lo, hi = int(bounds[0].strip()), int(bounds[1].strip())
                if lo > hi:
                    continue
                hi = min(hi, lo + _MAX_PAGE_RANGE - 1)
                result.extend(range(lo, hi + 1))
            except ValueError:
                pass
        else:
            try:
                result.append(int(part))
            except ValueError:
                pass
        if len(result) >= _MAX_TOTAL_PAGES:
            result = result[:_MAX_TOTAL_PAGES]
            break
    return result


def _reciprocal_rank_fusion(
    result_sets: Sequence[Sequence[Dict[str, Any]]],
    *,
    k: int = RRF_K,
    rrf_weights: Optional[Mapping[str, float]] = None,
) -> List[Dict[str, Any]]:
    """Reciprocal rank fusion with optional per-source weights.

    Each item's contribution is ``weight / (k + rank + 1)`` where
    ``weight`` is looked up from ``rrf_weights[item["source"]]`` (default
    ``1.0`` for unknown sources).
    """
    weights = dict(rrf_weights or {})
    scores: Dict[str, float] = {}
    canonical: Dict[str, Dict[str, Any]] = {}
    for results in result_sets:
        for rank, item in enumerate(results):
            chunk_id = item.get("chunk_id")
            if not chunk_id:
                continue
            source = str(item.get("source", ""))
            raw_w = weights.get(source, 1.0)
            try:
                weight = float(raw_w)
                if not math.isfinite(weight):
                    raise ValueError(
                        f"non-finite weight {raw_w!r} for source {source!r}"
                    )
            except (ValueError, TypeError) as exc:
                log.warning(
                    "rrf.invalid_weight", extra={"source": source, "error": str(exc)}
                )
                weight = 1.0
            scores[chunk_id] = scores.get(chunk_id, 0.0) + weight / (k + rank + 1)
            canonical.setdefault(chunk_id, dict(item))
    out: List[Dict[str, Any]] = []
    for chunk_id, score in sorted(scores.items(), key=lambda kv: kv[1], reverse=True):
        entry = dict(canonical[chunk_id])
        entry["score"] = score
        entry["source"] = "hybrid"
        out.append(entry)
    return out


__all__ = [
    "SearchService",
    "SearchHit",
    "RRF_K",
    "RetrieverConfig",
    "DEFAULT_RRF_WEIGHTS",
]
