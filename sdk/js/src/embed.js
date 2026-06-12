/**
 * embed.js — lazy local embedder using @huggingface/transformers (optional dep)
 * Browser-safe: no node: imports.
 */

const MODEL = 'Xenova/multilingual-e5-small';
const PREFIX = 'query: ';

let _pipe = null;

/**
 * Embed a text string to a Float32Array using the multilingual-e5-small model.
 * Lazily imports @huggingface/transformers on first call.
 *
 * @param {string} text - raw text (prefix added internally)
 * @param {Function} [pipelineLoader] - injectable for testing; defaults to real import
 * @returns {Promise<Float32Array>}
 */
export async function embedText(text, pipelineLoader) {
  const loader = pipelineLoader ?? defaultLoader;

  let pipeline;
  try {
    pipeline = await loader();
  } catch (err) {
    throw new Error(
      `Text embedding requires the optional dependency @huggingface/transformers.\n` +
      `Install it with: npm install @huggingface/transformers\n` +
      `Alternatively, pass a precomputed vector to search() instead of a text string.\n` +
      `(Original error: ${err.message})`
    );
  }

  const output = await pipeline(PREFIX + text, { pooling: 'mean', normalize: true });
  return output.data instanceof Float32Array ? output.data : new Float32Array(output.data);
}

async function defaultLoader() {
  if (_pipe) return _pipe;
  const { pipeline } = await import('@huggingface/transformers');
  _pipe = await pipeline('feature-extraction', MODEL);
  return _pipe;
}
