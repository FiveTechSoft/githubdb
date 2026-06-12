// engine/test/vectors.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeVector, decodeVector, toVector,
  cosineSim, dotProduct, euclidean
} from '../vectors.js';

test('encode/decode round-trip preserves float32 values', () => {
  const v = [0.25, -1.5, 3.0];
  const b64 = encodeVector(v);
  assert.equal(typeof b64, 'string');
  assert.deepEqual(Array.from(decodeVector(b64)), v);
});

test('decodeVector validates dimensions', () => {
  const b64 = encodeVector([1, 2, 3]);
  assert.throws(() => decodeVector(b64, 4), /expected 4, got 3/);
});

test('toVector accepts base64, array and Float32Array', () => {
  const arr = [1, 0, 0];
  assert.deepEqual(Array.from(toVector(encodeVector(arr))), arr);
  assert.deepEqual(Array.from(toVector(arr)), arr);
  assert.deepEqual(Array.from(toVector(Float32Array.from(arr))), arr);
  assert.throws(() => toVector(42), /Invalid vector/);
  assert.throws(() => toVector(arr, 4), /expected 4, got 3/);
});

test('cosineSim of identical vectors is 1, orthogonal is 0', () => {
  const a = Float32Array.from([1, 0]);
  const b = Float32Array.from([0, 1]);
  assert.ok(Math.abs(cosineSim(a, a) - 1) < 1e-6);
  assert.ok(Math.abs(cosineSim(a, b)) < 1e-6);
});

test('dotProduct and euclidean known values', () => {
  const a = Float32Array.from([1, 2]);
  const b = Float32Array.from([3, 4]);
  assert.equal(dotProduct(a, b), 11);
  assert.ok(Math.abs(euclidean(a, b) - Math.sqrt(8)) < 1e-6);
});

test('similarity functions reject mismatched lengths', () => {
  const a = Float32Array.from([1, 2]);
  const b = Float32Array.from([1, 2, 3]);
  assert.throws(() => cosineSim(a, b), /dimension/i);
});
