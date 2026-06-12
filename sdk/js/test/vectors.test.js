import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeVector, decodeVector, toVector, cosineSim } from '../src/vectors.js';

describe('encodeVector / decodeVector round-trip', () => {
  it('encodes and decodes known floats exactly', () => {
    const original = [1.0, -0.5, 0.25, 3.14159];
    const b64 = encodeVector(original);
    assert.ok(typeof b64 === 'string', 'encoded value should be a string');
    const decoded = decodeVector(b64, 4);
    assert.equal(decoded.length, 4);
    for (let i = 0; i < original.length; i++) {
      assert.ok(
        Math.abs(decoded[i] - original[i]) < 1e-5,
        `Element ${i}: expected ${original[i]}, got ${decoded[i]}`
      );
    }
  });

  it('round-trips a zero vector', () => {
    const original = [0, 0, 0];
    const b64 = encodeVector(original);
    const decoded = decodeVector(b64, 3);
    assert.deepEqual(Array.from(decoded), [0, 0, 0]);
  });

  it('round-trips negative and fractional floats', () => {
    const original = [-1.5, 2.7, -0.001];
    const b64 = encodeVector(original);
    const decoded = decodeVector(b64, 3);
    for (let i = 0; i < original.length; i++) {
      assert.ok(Math.abs(decoded[i] - original[i]) < 1e-4);
    }
  });
});

describe('decodeVector dims mismatch', () => {
  it('throws when dims does not match byte length', () => {
    const b64 = encodeVector([1.0, 2.0, 3.0]);
    assert.throws(
      () => decodeVector(b64, 5),
      /dimension mismatch|expected 5/i
    );
  });
});

describe('cosineSim', () => {
  it('returns 1.0 for identical unit vectors', () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    const sim = cosineSim(a, b);
    assert.ok(Math.abs(sim - 1.0) < 1e-6, `Expected ~1.0, got ${sim}`);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    const sim = cosineSim(a, b);
    assert.ok(Math.abs(sim) < 1e-6, `Expected ~0.0, got ${sim}`);
  });

  it('returns -1.0 for opposite unit vectors', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    const sim = cosineSim(a, b);
    assert.ok(Math.abs(sim + 1.0) < 1e-6, `Expected ~-1.0, got ${sim}`);
  });

  it('computes cosine similarity for known non-unit vectors', () => {
    // [3,4] and [4,3]: dot=24, |a|=5, |b|=5 => cos=24/25=0.96
    const sim = cosineSim([3, 4], [4, 3]);
    assert.ok(Math.abs(sim - 0.96) < 1e-5, `Expected ~0.96, got ${sim}`);
  });
});

describe('toVector', () => {
  it('passes through a plain array', () => {
    const v = toVector([1, 2, 3], 3);
    assert.deepEqual(Array.from(v), [1, 2, 3]);
  });

  it('decodes a base64 string', () => {
    const b64 = encodeVector([1.0, 2.0]);
    const v = toVector(b64, 2);
    assert.ok(Math.abs(v[0] - 1.0) < 1e-5);
    assert.ok(Math.abs(v[1] - 2.0) < 1e-5);
  });

  it('passes through a Float32Array', () => {
    const fa = new Float32Array([0.5, 1.5]);
    const v = toVector(fa, 2);
    assert.ok(Math.abs(v[0] - 0.5) < 1e-5);
    assert.ok(Math.abs(v[1] - 1.5) < 1e-5);
  });
});
