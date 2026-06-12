/**
 * vectors.js — browser-safe base64 / float32 utilities
 * Uses atob/btoa + DataView (no Buffer, no node: imports)
 */

/**
 * Encode an array of numbers as a base64 string of little-endian float32.
 * @param {number[]|Float32Array} arr
 * @returns {string} base64
 */
export function encodeVector(arr) {
  const buf = new ArrayBuffer(arr.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < arr.length; i++) {
    view.setFloat32(i * 4, arr[i], true); // little-endian
  }
  // Convert to base64 without Buffer
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode a base64 string of little-endian float32 into a Float32Array.
 * @param {string} b64
 * @param {number} [dims] - expected number of floats; throws if mismatch
 * @returns {Float32Array}
 */
export function decodeVector(b64, dims) {
  const binary = atob(b64);
  const byteLength = binary.length;
  const actualDims = byteLength / 4;

  if (dims !== undefined && actualDims !== dims) {
    throw new Error(
      `Vector dimension mismatch: expected ${dims}, got ${actualDims}`
    );
  }

  const buf = new ArrayBuffer(byteLength);
  const view = new DataView(buf);
  for (let i = 0; i < byteLength; i++) {
    view.setUint8(i, binary.charCodeAt(i));
  }
  const result = new Float32Array(actualDims);
  for (let i = 0; i < actualDims; i++) {
    result[i] = view.getFloat32(i * 4, true); // little-endian
  }
  return result;
}

/**
 * Convert a query value to a Float32Array.
 * Accepts: plain array, Float32Array, or base64 string.
 * @param {number[]|Float32Array|string} v
 * @param {number} [dims]
 * @returns {Float32Array}
 */
export function toVector(v, dims) {
  if (typeof v === 'string') {
    return decodeVector(v, dims);
  }
  if (v instanceof Float32Array) {
    if (dims !== undefined && v.length !== dims) {
      throw new Error(`Vector dimension mismatch: expected ${dims}, got ${v.length}`);
    }
    return v;
  }
  // plain array
  if (dims !== undefined && v.length !== dims) {
    throw new Error(`Vector dimension mismatch: expected ${dims}, got ${v.length}`);
  }
  return new Float32Array(v);
}

/**
 * Cosine similarity between two vectors (array or Float32Array).
 * @param {number[]|Float32Array} a
 * @param {number[]|Float32Array} b
 * @returns {number}
 */
export function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}
