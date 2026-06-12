"""
Shared fixture data for githubdb_sdk tests.
All returned as dicts/JSON bytes to be fed to fake transports.
Format mirrors the real githubDB layout: `tables` is a dict keyed by table
name; shards are plain filenames under data/.
"""
import json
from githubdb_sdk.vectors import encode_vector

# ---------------------------------------------------------------------------
# Simple DB (no shards, no vectors)
# ---------------------------------------------------------------------------

SIMPLE_DB = {
    "githubdb": 1,
    "tables": {
        "users": {
            "columns": [
                {"name": "id", "type": "INTEGER"},
                {"name": "name", "type": "TEXT"},
            ],
            "rows": [
                [1, "Alice"],
                [2, "Bob"],
            ],
        }
    },
}

SIMPLE_DB_BYTES = json.dumps(SIMPLE_DB).encode("utf-8")

# ---------------------------------------------------------------------------
# DB with shards
# ---------------------------------------------------------------------------

SHARD_DB = {
    "githubdb": 1,
    "tables": {
        "items": {
            "columns": [
                {"name": "id", "type": "INTEGER"},
                {"name": "label", "type": "TEXT"},
            ],
            "rows": [
                [1, "inline-a"],
                [2, "inline-b"],
            ],
            "shards": [
                "items_1.json",
                "items_2.json",
            ],
        }
    },
}

SHARD_DB_BYTES = json.dumps(SHARD_DB).encode("utf-8")

# URLs the SDK is expected to request for the shards above (no token).
SHARD_1_URL = "https://raw.githubusercontent.com/owner/repo/main/data/items_1.json"
SHARD_2_URL = "https://raw.githubusercontent.com/owner/repo/main/data/items_2.json"

SHARD_1 = {"table": "items", "rows": [[3, "shard1-a"], [4, "shard1-b"]]}
SHARD_2 = {"table": "items", "rows": [[5, "shard2-a"]]}

SHARD_1_BYTES = json.dumps(SHARD_1).encode("utf-8")
SHARD_2_BYTES = json.dumps(SHARD_2).encode("utf-8")

# ---------------------------------------------------------------------------
# DB with 3-dim VECTOR column
# ---------------------------------------------------------------------------

VEC_A = [1.0, 0.0, 0.0]
VEC_B = [0.0, 1.0, 0.0]
VEC_C = [0.5, 0.5, 0.0]  # cosine to VEC_A = 1/sqrt(2) ~0.707, to VEC_B ~0.707

VECTOR_DB = {
    "githubdb": 1,
    "tables": {
        "docs": {
            "columns": [
                {"name": "id", "type": "INTEGER"},
                {"name": "text", "type": "TEXT"},
                {"name": "vec", "type": "VECTOR(3)"},
                {"name": "category", "type": "TEXT"},
            ],
            "rows": [
                [1, "doc-a", encode_vector(VEC_A), "cat1"],
                [2, "doc-b", encode_vector(VEC_B), "cat2"],
                [3, "doc-c", encode_vector(VEC_C), "cat1"],
                [4, "doc-d", None, "cat2"],           # null vector — must be skipped
            ],
        }
    },
}

VECTOR_DB_BYTES = json.dumps(VECTOR_DB).encode("utf-8")
