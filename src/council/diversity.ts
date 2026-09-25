import { embed } from "../ai/workers-ai";
import { SYSTEM_MODELS } from "../config";
import { cosine, meanPairwiseSimilarity } from "../evals/suite";

/** Blind-round answers more similar than this (mean pairwise cosine) count as groupthink. */
export const GROUPTHINK_THRESHOLD = 0.9;

export const CONTRARIAN_INSTRUCTION =
  "The other members' first answers turned out nearly identical. Your job this round: take the strongest opposing position you can honestly defend. Say up front that you're deliberately arguing the other side, then make the best case against the emerging consensus.";

/** Index of the answer closest to all the others: the most "typical" one to replace. */
export function mostTypical(vectors: number[][]): number {
  let best = 0;
  let bestScore = -Infinity;
  vectors.forEach((v, i) => {
    const score = vectors.reduce((acc, w, j) => (i === j ? acc : acc + cosine(v, w)), 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

export async function groupthink(ai: Ai, texts: string[]): Promise<{ similarity: number; typical: number } | null> {
  if (texts.length < 3) return null;
  const vectors = await embed(ai, SYSTEM_MODELS.embeddings, texts.map((t) => t.slice(0, 2000)));
  if (vectors.length !== texts.length) return null;
  const similarity = meanPairwiseSimilarity(vectors);
  return similarity >= GROUPTHINK_THRESHOLD ? { similarity, typical: mostTypical(vectors) } : null;
}
