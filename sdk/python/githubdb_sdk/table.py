"""
Table: wraps a single githubDB table definition (columns + rows).
Provides objects(), search().
"""

import re
from .errors import GithubDBError
from .vectors import to_vector, cosine_sim

_VECTOR_RE = re.compile(r"^VECTOR\((\d+)\)$")


class Table:
    """Represents one table in a githubDB database.

    Args:
        name: table name.
        db: database name (used in error messages).
        columns: list of column dicts from the JSON schema.
        rows: list of row lists (parallel to columns).
        embedder: optional callable (str -> list[float]) injected by the client.
    """

    def __init__(self, name: str, db: str, columns: list, rows: list, embedder=None):
        self._name = name
        self._db = db
        self.columns = columns
        self.rows = rows
        self._embedder = embedder

    # ------------------------------------------------------------------
    # Public helpers
    # ------------------------------------------------------------------

    def objects(self) -> list:
        """Return rows as a list of dicts keyed by column name."""
        col_names = [c["name"] for c in self.columns]
        return [dict(zip(col_names, row)) for row in self.rows]

    def search(self, query, limit: int = 10, where=None) -> list:
        """Semantic search over the VECTOR column.

        Args:
            query: str (will be embedded), list/tuple of floats, or base64 str.
            limit: max results to return.
            where: optional predicate (dict -> bool) applied before ranking.

        Returns:
            list of {"row": dict, "score": float} sorted descending by score.
        """
        vec_col_idx, vec_dims = self._find_vector_column()

        # Resolve query vector
        if isinstance(query, str) and not self._looks_like_base64_vector(query, vec_dims):
            # Text query — embed it
            embed_fn = self._resolve_embedder()
            q_vec = embed_fn(query)
            if len(q_vec) != vec_dims:
                raise GithubDBError(
                    f"Vector dimension mismatch: expected {vec_dims}, got {len(q_vec)}"
                )
        else:
            # Precomputed: list, tuple, or base64 string
            try:
                q_vec = to_vector(query, dims=vec_dims)
            except ValueError as exc:
                raise GithubDBError(str(exc)) from exc

        col_names = [c["name"] for c in self.columns]
        results = []

        for i, row in enumerate(self.rows):
            obj = dict(zip(col_names, row))

            # Apply where predicate
            if where is not None and not where(obj):
                continue

            cell = row[vec_col_idx]
            if cell is None:
                continue

            try:
                row_vec = to_vector(cell, dims=vec_dims)
            except ValueError:
                continue

            score = cosine_sim(q_vec, row_vec)
            results.append((score, i, obj))

        # Sort descending by score, stable by original index
        results.sort(key=lambda x: (-x[0], x[1]))
        return [{"row": obj, "score": score} for score, _, obj in results[:limit]]

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _find_vector_column(self):
        """Find the first VECTOR(n) column.

        Returns:
            (column_index, dims) tuple.

        Raises:
            GithubDBError if no VECTOR column exists.
        """
        for idx, col in enumerate(self.columns):
            m = _VECTOR_RE.match(col.get("type", ""))
            if m:
                return idx, int(m.group(1))
        raise GithubDBError(f"Table '{self._name}' has no VECTOR column")

    def _resolve_embedder(self):
        """Return the embedder callable, lazy-loading if not injected."""
        if self._embedder is not None:
            return self._embedder
        # Lazy import
        from .embed import get_embedder  # noqa: PLC0415
        return get_embedder()

    @staticmethod
    def _looks_like_base64_vector(s: str, dims: int) -> bool:
        """Heuristic: a base64 vector of `dims` float32s has exactly dims*4 bytes.

        A short string (e.g. a word to embed) will be much shorter than that.
        We detect base64 if the decoded byte length equals dims*4.
        """
        import base64 as _b64
        # base64 length for dims float32: ceil(dims*4/3)*4 chars
        expected_b64_len = ((dims * 4 + 2) // 3) * 4
        if len(s) != expected_b64_len:
            return False
        try:
            raw = _b64.b64decode(s)
            return len(raw) == dims * 4
        except Exception:
            return False
