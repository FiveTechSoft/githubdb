"""
githubdb_sdk — Python read SDK for githubDB.

Public API:
    GithubDB    — main client class
    GithubDBError — exception raised by all SDK errors
    encode_vector, decode_vector, to_vector, cosine_sim — vector utilities
"""

from .errors import GithubDBError
from .client import GithubDB
from .vectors import encode_vector, decode_vector, to_vector, cosine_sim

__all__ = [
    "GithubDB",
    "GithubDBError",
    "encode_vector",
    "decode_vector",
    "to_vector",
    "cosine_sim",
]
