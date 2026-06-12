"""
Vector utilities: base64 <-> list[float] (float32 little-endian), cosine similarity.
No numpy required.
"""

import base64
import struct
import math


def encode_vector(values) -> str:
    """Encode a sequence of floats to a base64 little-endian float32 string."""
    packed = struct.pack(f"<{len(values)}f", *values)
    return base64.b64encode(packed).decode("ascii")


def decode_vector(b64: str, dims: int = None) -> list:
    """Decode a base64 little-endian float32 string to list[float].

    Args:
        b64: base64-encoded bytes representing float32 little-endian values.
        dims: expected number of dimensions; if provided and mismatched, raises ValueError.

    Returns:
        list of floats.
    """
    raw = base64.b64decode(b64)
    n = len(raw) // 4
    values = list(struct.unpack(f"<{n}f", raw))
    if dims is not None and len(values) != dims:
        raise ValueError(
            f"Vector dimension mismatch: expected {dims}, got {len(values)}"
        )
    return values


def to_vector(value, dims: int = None) -> list:
    """Convert a value (list/tuple of numbers or base64 string) to list[float].

    Args:
        value: list/tuple of numbers OR a base64-encoded string.
        dims: if provided, validates the resulting dimension.

    Returns:
        list of floats.
    """
    if isinstance(value, str):
        return decode_vector(value, dims=dims)
    result = list(float(v) for v in value)
    if dims is not None and len(result) != dims:
        raise ValueError(
            f"Vector dimension mismatch: expected {dims}, got {len(result)}"
        )
    return result


def cosine_sim(a, b) -> float:
    """Compute cosine similarity between two vectors (lists of floats).

    Returns a float in [-1, 1]. Returns 0.0 if either vector is zero.
    """
    dot = sum(x * y for x, y in zip(a, b))
    mag_a = math.sqrt(sum(x * x for x in a))
    mag_b = math.sqrt(sum(y * y for y in b))
    if mag_a == 0.0 or mag_b == 0.0:
        return 0.0
    return dot / (mag_a * mag_b)
