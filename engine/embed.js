// engine/embed.js
// Local embeddings with multilingual-e5-small (384 dims) via transformers.js.
// e5 models expect 'query: ' / 'passage: ' prefixes for asymmetric retrieval.

let pipePromise;

async function getPipe() {
  pipePromise ??= (async () => {
    const { pipeline } = await import('@huggingface/transformers');
    return pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
  })();
  return pipePromise;
}

async function embedWithPrefix(prefix, text) {
  const pipe = await getPipe();
  const out = await pipe(prefix + text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

export const embedPassage = (text) => embedWithPrefix('passage: ', text);
export const embedQuery = (text) => embedWithPrefix('query: ', text);
