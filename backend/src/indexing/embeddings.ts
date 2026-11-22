/**
 * Embeddings adapter — port of the indexing_model_server boundary:
 *   backend/onyx/indexing/embedder.py   (IndexingEmbedder L34 / DefaultIndexingEmbedder L91:
 *       embed_chunks takes texts and returns vectors for the configured model)
 *   backend/onyx/natural_language_processing/search_nlp_models.py (EmbeddingModel
 *       interface: encode_query / encode_passage returning fixed-dim vectors)
 *
 * This adapter is the LOCAL stand-in for the embedding model server boundary.
 * Standard Onyx reaches cloud providers (OpenAI / Voyage / mixedbread) across
 * the indexing_model_server HTTP boundary; with the same `EmbeddingProvider`
 * interface a network provider can be swapped in via ONYX_EMBEDDING_PROVIDER.
 * The local implementation is a deterministic, dependency-free feature hasher
 * (stable FNV-1a feature hashing of lowercase word n-grams, sublinear TF, L2
 * normalization) so indexing and search are fully offline and reproducible.
 */
import {
  INDEXING_BATCH_SIZE,
  INDEXING_EMBEDDING_DIM,
  INDEXING_EMBEDDING_MODEL,
} from "../configs/constants.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("indexing.embeddings");

export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** Stable 32-bit FNV-1a (deterministic across runs/processes). */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5; // 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619 mod 2^32 via 32-bit shifts
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash >>> 0;
}

/** Lowercase word tokens; non-alphanumeric runs act as separators. */
function wordTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * LocalHashEmbedder — deterministic feature-hashing embedder.
 *
 * Features: word unigrams and bigrams of the lowercased text. Each feature is
 * mapped to a bucket via fnv1a32(feature) % dim. Occurrences are counted
 * (term frequency); each bucket weight is the sublinear TF (1 + ln tf).
 * Unigrams and bigrams contribute equally (documented deviation: the adapter
 * does not attempt model-quality weighting — it exists to make the pipeline
 * runnable offline with a stable vector space).
 */
export class LocalHashEmbedder implements EmbeddingProvider {
  readonly model = INDEXING_EMBEDDING_MODEL;
  readonly dim = INDEXING_EMBEDDING_DIM;

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.embedOne(t)));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dim).fill(0);
    const words = wordTokens(text);

    const features: string[] = [];
    for (let i = 0; i < words.length; i++) {
      features.push(words[i]);
      if (i + 1 < words.length) features.push(`${words[i]} ${words[i + 1]}`);
    }
    if (features.length === 0) return vector;

    const tf = new Map<string, number>();
    for (const feature of features) {
      tf.set(feature, (tf.get(feature) ?? 0) + 1);
    }

    for (const [feature, count] of tf) {
      const bucket = fnv1a32(feature) % this.dim;
      vector[bucket] += 1 + Math.log(count);
    }

    // L2 normalization; zero vectors (empty input) stay all-zero.
    let norm = 0;
    for (const v of vector) norm += v * v;
    if (norm > 0) {
      norm = Math.sqrt(norm);
      for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    }
    return vector;
  }
}

let provider: EmbeddingProvider | null = null;

/**
 * Port of embedder.py's embedder construction from search settings. A cloud
 * provider (OpenAI / Voyage) would slot in here behind the same interface.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!provider) {
    provider = new LocalHashEmbedder();
    logger.info("using local hash embedding provider", {
      model: provider.model,
      dim: provider.dim,
    });
  }
  return provider;
}

/** Convenience wrapper mirroring DefaultIndexingEmbedder.embed_chunks. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const p = getEmbeddingProvider();
  if (texts.length === 0) return [];
  // Batch like Onyx embed_chunks (MAX_CHUNKS_PER_DOC_BATCH ~= INDEXING_BATCH_SIZE).
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += INDEXING_BATCH_SIZE) {
    const batch = texts.slice(i, i + INDEXING_BATCH_SIZE);
    out.push(...(await p.embed(batch)));
  }
  return out;
}
