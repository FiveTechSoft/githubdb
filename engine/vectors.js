// engine/vectors.js
// Vectors are stored in cells as base64-encoded little-endian float32.

export function encodeVector(values) {
  const f = Float32Array.from(values);
  return Buffer.from(f.buffer, 0, f.byteLength).toString('base64');
}

export function decodeVector(b64, dims) {
  const buf = Buffer.from(Buffer.from(b64, 'base64'));
  const n = buf.byteLength / 4;
  if (dims !== undefined && n !== dims) {
    throw new Error(`Vector dimension mismatch: expected ${dims}, got ${n}`);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, n);
}

export function toVector(value, dims) {
  if (typeof value === 'string') return decodeVector(value, dims);
  if (Array.isArray(value) || value instanceof Float32Array) {
    if (dims !== undefined && value.length !== dims) {
      throw new Error(`Vector dimension mismatch: expected ${dims}, got ${value.length}`);
    }
    return Float32Array.from(value);
  }
  throw new Error('Invalid vector value: expected base64 string or number array');
}

function checkSameLength(a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
}

export function dotProduct(a, b) {
  checkSameLength(a, b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function cosineSim(a, b) {
  checkSameLength(a, b);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function euclidean(a, b) {
  checkSameLength(a, b);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}
