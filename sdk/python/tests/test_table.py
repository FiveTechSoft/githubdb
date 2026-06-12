"""
Tests for githubdb_sdk.table.Table
"""
import json
import pytest

from githubdb_sdk import GithubDB, GithubDBError
from githubdb_sdk.vectors import encode_vector, cosine_sim
from .fixtures import (
    VECTOR_DB,
    VECTOR_DB_BYTES,
    SIMPLE_DB_BYTES,
    VEC_A, VEC_B, VEC_C,
)

VECTOR_DB_URL = "https://raw.githubusercontent.com/owner/repo/main/data/vdb.json"
SIMPLE_DB_URL = "https://raw.githubusercontent.com/owner/repo/main/data/mydb.json"


def make_transport(url_map):
    def transport(method, url, headers, body):
        return url_map.get(url, (404, b"not found"))
    return transport


def make_vector_gdb(**kwargs):
    transport = make_transport({VECTOR_DB_URL: (200, VECTOR_DB_BYTES)})
    return GithubDB("owner", repo="repo", transport=transport, **kwargs)


# ---------------------------------------------------------------------------
# objects()
# ---------------------------------------------------------------------------

class TestObjects:
    def test_objects_returns_list_of_dicts(self):
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        objs = t.objects()
        assert isinstance(objs, list)
        assert all(isinstance(o, dict) for o in objs)

    def test_objects_keys_match_columns(self):
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        objs = t.objects()
        expected_keys = {"id", "text", "vec", "category"}
        assert set(objs[0].keys()) == expected_keys

    def test_objects_count(self):
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        assert len(t.objects()) == 4  # including null-vector row


# ---------------------------------------------------------------------------
# search: precomputed vectors — order, limit, where, null-vector skipped
# ---------------------------------------------------------------------------

class TestSearchPrecomputed:
    def test_search_by_list_vector_returns_results(self):
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        results = t.search(VEC_A)
        assert len(results) > 0
        assert all("row" in r and "score" in r for r in results)

    def test_search_planted_order(self):
        """Querying with VEC_A: doc-a (score=1) should rank first."""
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        results = t.search(VEC_A)
        assert results[0]["row"]["text"] == "doc-a"
        assert abs(results[0]["score"] - 1.0) < 1e-5

    def test_search_limit(self):
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        results = t.search(VEC_A, limit=2)
        assert len(results) == 2

    def test_search_limit_1(self):
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        results = t.search(VEC_A, limit=1)
        assert len(results) == 1
        assert results[0]["row"]["text"] == "doc-a"

    def test_search_where_prefilter(self):
        """Only cat1 rows should appear when where filters by category."""
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        results = t.search(VEC_B, where=lambda r: r["category"] == "cat2")
        texts = [r["row"]["text"] for r in results]
        # doc-b (VEC_B) is cat2, doc-d is cat2 but null vector (skipped)
        assert all(r["row"]["category"] == "cat2" for r in results)
        assert "doc-b" in texts

    def test_null_vector_skipped(self):
        """doc-d has null vector; it must not appear in results."""
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        results = t.search(VEC_A, limit=10)
        ids = [r["row"]["id"] for r in results]
        assert 4 not in ids  # doc-d has id=4

    def test_results_sorted_descending(self):
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        results = t.search(VEC_A, limit=10)
        scores = [r["score"] for r in results]
        assert scores == sorted(scores, reverse=True)

    def test_score_values_are_floats(self):
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        results = t.search(VEC_A)
        for r in results:
            assert isinstance(r["score"], float)


# ---------------------------------------------------------------------------
# search: base64 query
# ---------------------------------------------------------------------------

class TestSearchBase64Query:
    def test_base64_query_accepted(self):
        b64 = encode_vector(VEC_A)
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        results = t.search(b64)
        assert results[0]["row"]["text"] == "doc-a"

    def test_base64_gives_same_result_as_list(self):
        b64 = encode_vector(VEC_A)
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        res_b64 = t.search(b64)
        res_list = t.search(VEC_A)
        assert [r["row"]["id"] for r in res_b64] == [r["row"]["id"] for r in res_list]


# ---------------------------------------------------------------------------
# search: dims mismatch
# ---------------------------------------------------------------------------

class TestSearchDimsMismatch:
    def test_wrong_dims_raises_githubdberror(self):
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        wrong_dim_vec = [1.0, 0.0]  # 2-dim but VECTOR(3)
        with pytest.raises(GithubDBError, match="Vector dimension mismatch"):
            t.search(wrong_dim_vec)

    def test_mismatch_message_includes_expected_and_got(self):
        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")
        with pytest.raises(GithubDBError) as exc_info:
            t.search([1.0, 0.0])  # 2-dim vs VECTOR(3)
        assert "expected 3" in str(exc_info.value)
        assert "got 2" in str(exc_info.value)


# ---------------------------------------------------------------------------
# search: no VECTOR column
# ---------------------------------------------------------------------------

class TestNoVectorColumn:
    def test_no_vector_column_raises(self):
        transport = make_transport({SIMPLE_DB_URL: (200, SIMPLE_DB_BYTES)})
        gdb = GithubDB("owner", repo="repo", transport=transport)
        t = gdb.table("mydb", "users")
        with pytest.raises(GithubDBError, match="Table 'users' has no VECTOR column"):
            t.search([1.0, 2.0])


# ---------------------------------------------------------------------------
# search: text query with injected fake embedder
# ---------------------------------------------------------------------------

class TestTextSearchFakeEmbedder:
    def test_fake_embedder_called_with_raw_text(self):
        """The embedder must receive the raw query text (not prefixed)."""
        received = {}

        def fake_embedder(text: str):
            received["text"] = text
            return VEC_A  # return a valid 3-dim vector

        gdb = make_vector_gdb(embedder=fake_embedder)
        t = gdb.table("vdb", "docs")
        t.search("hello world")
        assert received["text"] == "hello world"

    def test_fake_embedder_result_used_for_ranking(self):
        """With fake embedder returning VEC_A, doc-a should be top result."""
        def fake_embedder(text: str):
            return VEC_A

        gdb = make_vector_gdb(embedder=fake_embedder)
        t = gdb.table("vdb", "docs")
        results = t.search("any text")
        assert results[0]["row"]["text"] == "doc-a"

    def test_fake_embedder_returning_vec_b(self):
        """With fake embedder returning VEC_B, doc-b should be top result."""
        def fake_embedder(text: str):
            return VEC_B

        gdb = make_vector_gdb(embedder=fake_embedder)
        t = gdb.table("vdb", "docs")
        results = t.search("any text")
        assert results[0]["row"]["text"] == "doc-b"


# ---------------------------------------------------------------------------
# search: missing sentence-transformers → instructive error
# ---------------------------------------------------------------------------

class TestMissingEmbedDependency:
    def test_missing_dep_raises_githubdberror(self, monkeypatch):
        """When sentence_transformers is not installed, search(text) raises a
        GithubDBError with an instructive message."""
        import builtins
        real_import = builtins.__import__

        def mock_import(name, *args, **kwargs):
            if name == "sentence_transformers":
                raise ImportError("No module named 'sentence_transformers'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", mock_import)

        # Clear the module cache so the lazy import is retried
        import githubdb_sdk.embed as embed_mod
        monkeypatch.setattr(embed_mod, "_cached_model", None)

        gdb = make_vector_gdb()  # no embedder injected
        t = gdb.table("vdb", "docs")

        with pytest.raises(GithubDBError) as exc_info:
            t.search("some text query")

        msg = str(exc_info.value)
        # Must include install instructions
        assert "pip install" in msg
        # Must mention the embed extra or sentence-transformers
        assert "sentence-transformers" in msg or "githubdb-sdk[embed]" in msg

    def test_missing_dep_error_mentions_alternative(self, monkeypatch):
        """Error message must mention the precomputed-vector alternative."""
        import builtins
        real_import = builtins.__import__

        def mock_import(name, *args, **kwargs):
            if name == "sentence_transformers":
                raise ImportError("No module named 'sentence_transformers'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", mock_import)

        import githubdb_sdk.embed as embed_mod
        monkeypatch.setattr(embed_mod, "_cached_model", None)

        gdb = make_vector_gdb()
        t = gdb.table("vdb", "docs")

        with pytest.raises(GithubDBError) as exc_info:
            t.search("some text")

        msg = str(exc_info.value)
        # Should hint at the precomputed vector alternative
        assert "precomputed" in msg or "vector" in msg.lower()
