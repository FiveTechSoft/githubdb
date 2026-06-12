<?php

use GithubDB\Vectors;
use GithubDB\GithubDBException;
use PHPUnit\Framework\TestCase;

class VectorsTest extends TestCase
{
    // -------------------------------------------------------------------------
    // encode / decode round-trip
    // -------------------------------------------------------------------------

    public function testEncodeDecodeRoundTripSingleFloat(): void
    {
        $original = [1.0];
        $encoded = Vectors::encode($original);
        $decoded = Vectors::decode($encoded);

        $this->assertCount(1, $decoded);
        $this->assertEqualsWithDelta($original[0], $decoded[0], 1e-6 * abs($original[0]) + 1e-9);
    }

    public function testEncodeDecodeRoundTripMultipleFloats(): void
    {
        $original = [0.1, -0.5, 3.14159, 100.0, -0.0001];
        $encoded = Vectors::encode($original);
        $decoded = Vectors::decode($encoded);

        $this->assertCount(count($original), $decoded);
        foreach ($original as $i => $v) {
            $delta = max(1e-6 * abs($v), 1e-9);
            $this->assertEqualsWithDelta($v, $decoded[$i], $delta, "Mismatch at index $i");
        }
    }

    public function testEncodeDecodeRoundTripThreeDims(): void
    {
        $original = [0.6, 0.8, 0.0];
        $encoded = Vectors::encode($original);
        $decoded = Vectors::decode($encoded, 3);

        $this->assertCount(3, $decoded);
        foreach ($original as $i => $v) {
            $delta = max(1e-6 * abs($v), 1e-9);
            $this->assertEqualsWithDelta($v, $decoded[$i], $delta, "Mismatch at index $i");
        }
    }

    public function testDecodeReturnsZeroIndexedArray(): void
    {
        // Verify unpack 1-indexed issue is fixed — array must start at 0
        $encoded = Vectors::encode([1.0, 2.0]);
        $decoded = Vectors::decode($encoded);
        $this->assertArrayHasKey(0, $decoded);
        $this->assertArrayHasKey(1, $decoded);
        $this->assertArrayNotHasKey(2, $decoded);
    }

    public function testEncodeDecodeEmptyArray(): void
    {
        $encoded = Vectors::encode([]);
        $decoded = Vectors::decode($encoded);
        $this->assertSame([], $decoded);
    }

    // -------------------------------------------------------------------------
    // dims mismatch
    // -------------------------------------------------------------------------

    public function testDecodeDimsMismatchThrows(): void
    {
        $encoded = Vectors::encode([1.0, 2.0, 3.0]); // 3 floats
        $this->expectException(GithubDBException::class);
        $this->expectExceptionMessageMatches('/expected 2, got 3/');
        Vectors::decode($encoded, 2);
    }

    public function testToVectorArrayDimsMismatch(): void
    {
        $this->expectException(GithubDBException::class);
        $this->expectExceptionMessageMatches('/expected 2, got 3/');
        Vectors::toVector([1.0, 2.0, 3.0], 2);
    }

    public function testToVectorBase64DimsMismatch(): void
    {
        $encoded = Vectors::encode([1.0, 2.0, 3.0]);
        $this->expectException(GithubDBException::class);
        $this->expectExceptionMessageMatches('/expected 4, got 3/');
        Vectors::toVector($encoded, 4);
    }

    // -------------------------------------------------------------------------
    // cosine similarity with known values
    // -------------------------------------------------------------------------

    public function testCosineSimIdenticalVectors(): void
    {
        $v = [1.0, 0.0, 0.0];
        $sim = Vectors::cosineSim($v, $v);
        $this->assertEqualsWithDelta(1.0, $sim, 1e-6);
    }

    public function testCosineSimOrthogonalVectors(): void
    {
        $a = [1.0, 0.0];
        $b = [0.0, 1.0];
        $sim = Vectors::cosineSim($a, $b);
        $this->assertEqualsWithDelta(0.0, $sim, 1e-6);
    }

    public function testCosineSimOppositeVectors(): void
    {
        $a = [1.0, 0.0];
        $b = [-1.0, 0.0];
        $sim = Vectors::cosineSim($a, $b);
        $this->assertEqualsWithDelta(-1.0, $sim, 1e-6);
    }

    public function testCosineSimKnownValue(): void
    {
        // [1,1,0] vs [1,0,0] → cosine = 1/sqrt(2) ≈ 0.7071...
        $a = [1.0, 1.0, 0.0];
        $b = [1.0, 0.0, 0.0];
        $expected = 1.0 / sqrt(2.0);
        $sim = Vectors::cosineSim($a, $b);
        $this->assertEqualsWithDelta($expected, $sim, 1e-6);
    }

    public function testCosineSimZeroVector(): void
    {
        $a = [0.0, 0.0];
        $b = [1.0, 0.0];
        $sim = Vectors::cosineSim($a, $b);
        $this->assertEqualsWithDelta(0.0, $sim, 1e-6);
    }

    // -------------------------------------------------------------------------
    // toVector
    // -------------------------------------------------------------------------

    public function testToVectorFromArray(): void
    {
        $v = [1.5, -2.3];
        $result = Vectors::toVector($v, 2);
        $this->assertCount(2, $result);
        $this->assertEqualsWithDelta(1.5, $result[0], 1e-6);
        $this->assertEqualsWithDelta(-2.3, $result[1], 1e-6);
    }

    public function testToVectorFromBase64(): void
    {
        $original = [0.25, 0.75, -0.5];
        $encoded = Vectors::encode($original);
        $result = Vectors::toVector($encoded, 3);
        foreach ($original as $i => $v) {
            $this->assertEqualsWithDelta($v, $result[$i], 1e-6);
        }
    }
}
