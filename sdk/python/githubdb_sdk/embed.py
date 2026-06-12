"""
Lazy embedding loader for sentence-transformers.
Provides get_embedder() which returns a callable (text -> list[float]).
"""

from .errors import GithubDBError

_MODEL_NAME = "intfloat/multilingual-e5-small"
_PREFIX = "query: "

_cached_model = None


def get_embedder():
    """Return a callable that embeds a single text string.

    Lazily imports sentence_transformers. Raises GithubDBError with an
    instructive message if the package is not installed.
    """
    global _cached_model
    if _cached_model is not None:
        return _make_embed_fn(_cached_model)

    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
    except ImportError:
        raise GithubDBError(
            "Text embedding requires sentence-transformers, which is not installed.\n"
            "Install it with:\n"
            "    pip install 'githubdb-sdk[embed]'\n"
            "or:\n"
            "    pip install sentence-transformers\n"
            "\n"
            "Alternatively, pass a precomputed vector (list of floats or base64 string) "
            "directly to search() to skip local embedding."
        )

    _cached_model = SentenceTransformer(_MODEL_NAME)
    return _make_embed_fn(_cached_model)


def _make_embed_fn(model):
    def embed(text: str) -> list:
        prefixed = _PREFIX + text
        vec = model.encode(prefixed, normalize_embeddings=True)
        return list(float(v) for v in vec)
    return embed
