"""
Tests for githubdb_sdk.client.GithubDB
"""
import json
import pytest

from githubdb_sdk import GithubDB, GithubDBError
from .fixtures import (
    SIMPLE_DB_BYTES,
    SHARD_DB_BYTES,
    SHARD_1_BYTES,
    SHARD_2_BYTES,
    VECTOR_DB_BYTES,
)

# ---------------------------------------------------------------------------
# Helper: build fake transports
# ---------------------------------------------------------------------------

def make_transport(url_map: dict):
    """Return a transport callable that looks up url in url_map.

    url_map keys are URLs; values are (status, bytes).
    Unknown URLs return 404.
    """
    def transport(method, url, headers, body):
        return url_map.get(url, (404, b'{"message": "Not Found"}'))
    return transport


def make_counting_transport(url_map: dict):
    """Like make_transport but also counts calls per URL."""
    calls = {}

    def transport(method, url, headers, body):
        calls[url] = calls.get(url, 0) + 1
        return url_map.get(url, (404, b'{"message": "Not Found"}'))

    transport.calls = calls
    return transport


# All tests use repo="repo" so URLs match raw.githubusercontent.com/owner/repo/main/...
SIMPLE_DB_URL = "https://raw.githubusercontent.com/owner/repo/main/data/mydb.json"
SIMPLE_DB_API_URL = (
    "https://api.github.com/repos/owner/repo/contents/data/mydb.json?ref=main"
)

# ---------------------------------------------------------------------------
# Simple read
# ---------------------------------------------------------------------------

class TestSimpleRead:
    def test_table_returns_table_object(self):
        transport = make_transport({SIMPLE_DB_URL: (200, SIMPLE_DB_BYTES)})
        gdb = GithubDB("owner", repo="repo", transport=transport)
        t = gdb.table("mydb", "users")
        assert t is not None
        assert t.columns[0]["name"] == "id"
        assert len(t.rows) == 2

    def test_objects_returns_dicts(self):
        transport = make_transport({SIMPLE_DB_URL: (200, SIMPLE_DB_BYTES)})
        gdb = GithubDB("owner", repo="repo", transport=transport)
        t = gdb.table("mydb", "users")
        objs = t.objects()
        assert objs == [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}]

    def test_columns_attribute(self):
        transport = make_transport({SIMPLE_DB_URL: (200, SIMPLE_DB_BYTES)})
        gdb = GithubDB("owner", repo="repo", transport=transport)
        t = gdb.table("mydb", "users")
        assert [c["name"] for c in t.columns] == ["id", "name"]

    def test_rows_attribute(self):
        transport = make_transport({SIMPLE_DB_URL: (200, SIMPLE_DB_BYTES)})
        gdb = GithubDB("owner", repo="repo", transport=transport)
        t = gdb.table("mydb", "users")
        assert t.rows == [[1, "Alice"], [2, "Bob"]]


# ---------------------------------------------------------------------------
# 404 → Database not found
# ---------------------------------------------------------------------------

class TestDatabaseNotFound:
    def test_404_raises_database_not_found(self):
        transport = make_transport({})  # everything → 404
        gdb = GithubDB("owner", repo="repo", transport=transport)
        with pytest.raises(GithubDBError, match="Database 'mydb' not found"):
            gdb.table("mydb", "users")

    def test_404_error_includes_db_name(self):
        transport = make_transport({})
        gdb = GithubDB("owner", repo="repo", transport=transport)
        with pytest.raises(GithubDBError) as exc_info:
            gdb.table("specialdb", "users")
        assert "specialdb" in str(exc_info.value)


# ---------------------------------------------------------------------------
# Unknown table → Table not found
# ---------------------------------------------------------------------------

class TestTableNotFound:
    def test_unknown_table_raises(self):
        transport = make_transport({SIMPLE_DB_URL: (200, SIMPLE_DB_BYTES)})
        gdb = GithubDB("owner", repo="repo", transport=transport)
        with pytest.raises(GithubDBError, match="Table 'ghost' not found in database 'mydb'"):
            gdb.table("mydb", "ghost")

    def test_error_includes_both_names(self):
        transport = make_transport({SIMPLE_DB_URL: (200, SIMPLE_DB_BYTES)})
        gdb = GithubDB("owner", repo="repo", transport=transport)
        with pytest.raises(GithubDBError) as exc_info:
            gdb.table("mydb", "ghost")
        assert "ghost" in str(exc_info.value)
        assert "mydb" in str(exc_info.value)


# ---------------------------------------------------------------------------
# Shard merge order: inline first, then shard1, then shard2
# ---------------------------------------------------------------------------

SHARD_DB_URL = "https://raw.githubusercontent.com/owner/repo/main/data/mydb.json"
SHARD_1_URL = "https://raw.githubusercontent.com/owner/repo/main/data/items_1.json"
SHARD_2_URL = "https://raw.githubusercontent.com/owner/repo/main/data/items_2.json"


class TestShardMerge:
    def _make_gdb(self):
        transport = make_transport({
            SHARD_DB_URL: (200, SHARD_DB_BYTES),
            SHARD_1_URL: (200, SHARD_1_BYTES),
            SHARD_2_URL: (200, SHARD_2_BYTES),
        })
        return GithubDB("owner", repo="repo", transport=transport)

    def test_all_rows_present(self):
        gdb = self._make_gdb()
        t = gdb.table("mydb", "items")
        objs = t.objects()
        labels = [o["label"] for o in objs]
        assert labels == ["inline-a", "inline-b", "shard1-a", "shard1-b", "shard2-a"]

    def test_inline_rows_before_shard_rows(self):
        gdb = self._make_gdb()
        t = gdb.table("mydb", "items")
        objs = t.objects()
        assert objs[0]["label"] == "inline-a"
        assert objs[1]["label"] == "inline-b"

    def test_shard1_before_shard2(self):
        gdb = self._make_gdb()
        t = gdb.table("mydb", "items")
        objs = t.objects()
        assert objs[2]["label"] == "shard1-a"
        assert objs[4]["label"] == "shard2-a"

    def test_total_row_count(self):
        gdb = self._make_gdb()
        t = gdb.table("mydb", "items")
        assert len(t.rows) == 5


# ---------------------------------------------------------------------------
# Cache (count transport calls) + refresh
# ---------------------------------------------------------------------------

class TestCacheAndRefresh:
    def test_second_table_call_does_not_fetch_again(self):
        transport = make_counting_transport({SIMPLE_DB_URL: (200, SIMPLE_DB_BYTES)})
        gdb = GithubDB("owner", repo="repo", transport=transport)
        gdb.table("mydb", "users")
        gdb.table("mydb", "users")
        assert transport.calls.get(SIMPLE_DB_URL, 0) == 1

    def test_refresh_triggers_refetch(self):
        transport = make_counting_transport({SIMPLE_DB_URL: (200, SIMPLE_DB_BYTES)})
        gdb = GithubDB("owner", repo="repo", transport=transport)
        gdb.table("mydb", "users")
        assert transport.calls.get(SIMPLE_DB_URL, 0) == 1
        gdb.refresh("mydb")
        assert transport.calls.get(SIMPLE_DB_URL, 0) == 2

    def test_different_dbs_fetched_independently(self):
        other_url = "https://raw.githubusercontent.com/owner/repo/main/data/other.json"
        transport = make_counting_transport({
            SIMPLE_DB_URL: (200, SIMPLE_DB_BYTES),
            other_url: (200, SIMPLE_DB_BYTES),
        })
        gdb = GithubDB("owner", repo="repo", transport=transport)
        gdb.table("mydb", "users")
        gdb.table("other", "users")
        assert transport.calls.get(SIMPLE_DB_URL, 0) == 1
        assert transport.calls.get(other_url, 0) == 1


# ---------------------------------------------------------------------------
# Token path: URL and headers
# ---------------------------------------------------------------------------

class TestTokenPath:
    def test_token_uses_api_url(self):
        seen = {}

        def transport(method, url, headers, body):
            seen["url"] = url
            seen["headers"] = headers
            return (200, SIMPLE_DB_BYTES)

        gdb = GithubDB("owner", repo="repo", token="my-token", transport=transport)
        gdb.table("mydb", "users")

        expected_url = SIMPLE_DB_API_URL
        assert seen["url"] == expected_url

    def test_token_sends_correct_headers(self):
        seen = {}

        def transport(method, url, headers, body):
            seen["headers"] = headers
            return (200, SIMPLE_DB_BYTES)

        gdb = GithubDB("owner", repo="repo", token="my-token", transport=transport)
        gdb.table("mydb", "users")

        assert seen["headers"].get("Accept") == "application/vnd.github.raw+json"
        assert seen["headers"].get("Authorization") == "Bearer my-token"

    def test_no_token_uses_raw_url(self):
        seen = {}

        def transport(method, url, headers, body):
            seen["url"] = url
            return (200, SIMPLE_DB_BYTES)

        gdb = GithubDB("owner", repo="repo", transport=transport)
        gdb.table("mydb", "users")

        assert "raw.githubusercontent.com" in seen["url"]
        assert "api.github.com" not in seen["url"]

    def test_token_with_custom_branch(self):
        seen = {}

        def transport(method, url, headers, body):
            seen["url"] = url
            return (200, SIMPLE_DB_BYTES)

        gdb = GithubDB("owner", repo="repo", branch="dev", token="tok", transport=transport)
        gdb.table("mydb", "users")

        assert "ref=dev" in seen["url"]
