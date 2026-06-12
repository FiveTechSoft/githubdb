"""
Tests for githubdb_sdk.vectors
"""
import math
import struct
import base64
import pytest

from githubdb_sdk.vectors import encode_vector, decode_vector, to_vector, cosine_sim


class TestEncodeDecodeRoundTrip:
    """Round-trip known floats through encode/decode."""

    def test_simple_roundtrip(self):
        values = [1.0, 2.0, 3.0]
        b64 = encode_vector(values)
        recovered = decode_vector(b64)
        assert len(recovered) == 3
        for orig, rec in zip(values, recovered):
            assert abs(orig - rec) < 1e-6, f"float32 precision: {orig} vs {rec}"

    def test_fractional_roundtrip(self):
        values = [0.1, -0.5, 0.333, 1.0, -1.0]
        b64 = encode_vector(values)
        recovered = decode_vector(b64)
        assert len(recovered) == len(values)
        for orig, rec in zip(values, recovered):
            # float32 precision: ~7 significant digits
            assert abs(orig - rec) < 1e-5, f"Expected ~{orig}, got {rec}"

    def test_single_value(self):
        b64 = encode_vector([42.0])
        result = decode_vector(b64)
        assert len(result) == 1
        assert abs(result[0] - 42.0) < 1e-6

    def test_known_bytes(self):
        """Manually build a known base64 and check decode."""
        # 1.0 as float32 LE = 0x3F800000 = bytes 00 00 80 3F
        packed = struct.pack("<f", 1.0)
        b64 = base64.b64encode(packed).decode("ascii")
        result = decode_vector(b64)
        assert len(result) == 1
        assert abs(result[0] - 1.0) < 1e-7

    def test_decode_with_correct_dims(self):
        b64 = encode_vector([1.0, 2.0, 3.0])
        result = decode_vector(b64, dims=3)
        assert len(result) == 3

    def test_decode_dims_mismatch_raises(self):
        b64 = encode_vector([1.0, 2.0, 3.0])
        with pytest.raises(ValueError, match=r"Vector dimension mismatch: expected 4, got 3"):
            decode_vector(b64, dims=4)

    def test_decode_dims_mismatch_message_format(self):
        """Exact error message format per spec."""
        b64 = encode_vector([1.0, 2.0])
        with pytest.raises(ValueError) as exc_info:
            decode_vector(b64, dims=5)
        assert "expected 5" in str(exc_info.value)
        assert "got 2" in str(exc_info.value)


class TestToVector:
    """to_vector() handles list, tuple, and base64 str."""

    def test_from_list(self):
        result = to_vector([1.0, 2.0, 3.0])
        assert result == [1.0, 2.0, 3.0]

    def test_from_tuple(self):
        result = to_vector((0.5, -0.5))
        assert result == [0.5, -0.5]

    def test_from_base64_string(self):
        b64 = encode_vector([1.0, 2.0, 3.0])
        result = to_vector(b64)
        assert len(result) == 3
        assert abs(result[0] - 1.0) < 1e-6

    def test_from_list_with_dims(self):
        result = to_vector([1.0, 2.0, 3.0], dims=3)
        assert len(result) == 3

    def test_from_list_dims_mismatch(self):
        with pytest.raises(ValueError, match="expected 4, got 3"):
            to_vector([1.0, 2.0, 3.0], dims=4)

    def test_from_base64_dims_mismatch(self):
        b64 = encode_vector([1.0, 2.0])
        with pytest.raises(ValueError, match="expected 3, got 2"):
            to_vector(b64, dims=3)


class TestCosineSim:
    """cosine_sim() returns expected values for known inputs."""

    def test_identical_vectors(self):
        a = [1.0, 0.0, 0.0]
        assert abs(cosine_sim(a, a) - 1.0) < 1e-7

    def test_orthogonal_vectors(self):
        a = [1.0, 0.0]
        b = [0.0, 1.0]
        assert abs(cosine_sim(a, b)) < 1e-7

    def test_opposite_vectors(self):
        a = [1.0, 0.0]
        b = [-1.0, 0.0]
        assert abs(cosine_sim(a, b) - (-1.0)) < 1e-7

    def test_known_value(self):
        # [1,1] vs [1,0]: cos = 1/sqrt(2) ~= 0.7071
        a = [1.0, 1.0]
        b = [1.0, 0.0]
        expected = 1.0 / math.sqrt(2)
        assert abs(cosine_sim(a, b) - expected) < 1e-6

    def test_zero_vector_returns_zero(self):
        assert cosine_sim([0.0, 0.0], [1.0, 2.0]) == 0.0
        assert cosine_sim([1.0, 2.0], [0.0, 0.0]) == 0.0

    def test_non_unit_vectors(self):
        # [3,4] vs [3,4]: cosine = 1.0
        v = [3.0, 4.0]
        assert abs(cosine_sim(v, v) - 1.0) < 1e-6

    def test_known_3d(self):
        a = [1.0, 0.0, 0.0]
        b = [0.5, 0.5, 0.0]
        # cos = 0.5 / (1 * sqrt(0.5)) = 1/sqrt(2)
        expected = 0.5 / math.sqrt(0.5)
        assert abs(cosine_sim(a, b) - expected) < 1e-6
