<?php

namespace GithubDB;

/**
 * Utility class for float32 LE vector encoding/decoding and cosine similarity.
 */
class Vectors
{
    /**
     * Encode an array of floats to a base64 float32-LE string.
     */
    public static function encode(array $values): string
    {
        if (empty($values)) {
            return base64_encode('');
        }
        $packed = pack('g*', ...$values);
        return base64_encode($packed);
    }

    /**
     * Decode a base64 float32-LE string to an array of floats.
     *
     * @param string   $b64  Base64-encoded float32 LE bytes.
     * @param int|null $dims Expected number of dimensions (optional validation).
     * @return float[]
     */
    public static function decode(string $b64, ?int $dims = null): array
    {
        $binary = base64_decode($b64, true);
        if ($binary === false || $binary === '') {
            return [];
        }

        $unpacked = unpack('g*', $binary);
        // unpack returns 1-indexed array — normalize with array_values
        $values = array_values($unpacked);

        if ($dims !== null && count($values) !== $dims) {
            throw new GithubDBException(
                "Vector dimension mismatch: expected {$dims}, got " . count($values)
            );
        }

        return $values;
    }

    /**
     * Convert a mixed value (float array, base64 string, or already-decoded) to a float array.
     *
     * @param mixed    $v    Float array, base64 string.
     * @param int|null $dims Expected dimensions (optional).
     * @return float[]
     */
    public static function toVector(mixed $v, ?int $dims = null): array
    {
        if (is_string($v)) {
            return self::decode($v, $dims);
        }

        if (is_array($v)) {
            if ($dims !== null && count($v) !== $dims) {
                throw new GithubDBException(
                    "Vector dimension mismatch: expected {$dims}, got " . count($v)
                );
            }
            return array_values(array_map('floatval', $v));
        }

        throw new GithubDBException('Cannot convert value to vector: expected array or base64 string');
    }

    /**
     * Compute cosine similarity between two float arrays.
     */
    public static function cosineSim(array $a, array $b): float
    {
        $dot = 0.0;
        $normA = 0.0;
        $normB = 0.0;

        $len = count($a);
        for ($i = 0; $i < $len; $i++) {
            $dot   += $a[$i] * $b[$i];
            $normA += $a[$i] * $a[$i];
            $normB += $b[$i] * $b[$i];
        }

        $denom = sqrt($normA) * sqrt($normB);
        if ($denom == 0.0) {
            return 0.0;
        }

        return $dot / $denom;
    }
}
