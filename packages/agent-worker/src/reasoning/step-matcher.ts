/**
 * Semantic step matcher used by `PlanExecuteExecutor` to carry successful
 * steps across a replan when the new plan picks a different `id` for a
 * semantically-equivalent goal.
 *
 * Trigger #1 and trigger #3 both call into `matchPreservedStep(newStep,
 * priorSuccesses, matcher)`:
 *   1. First try exact id match (cheap, zero-cost, handles the common case
 *      where the planner keeps ids stable).
 *   2. When no id match, fall back to the matcher if provided. The matcher
 *      compares `newStep.goal` against each prior success's goal and returns
 *      the best-matching id iff similarity ≥ its threshold.
 *   3. When no matcher is injected (or it returns null), we skip preservation
 *      and the step runs fresh.
 *
 * Kept contract-free so agent-worker doesn't take a runtime dep on the memory
 * package — platform.ts constructs `EmbedderStepMatcher` from whichever
 * embedder it already wired for the palace.
 */
export interface StepMatcher {
  /**
   * Return the id of the best semantic match for `queryGoal` among
   * `candidates`, or `null` when no candidate clears the matcher's internal
   * threshold.
   */
  match(
    queryGoal: string,
    candidates: ReadonlyArray<{ id: string; goal: string }>,
  ): Promise<string | null>;
}

/**
 * Narrow embed signature — just `string → Float32Array`. Decouples this module
 * from `@agent-platform/memory`'s `EmbeddingProvider` so agent-worker can stay
 * dep-free. platform.ts binds this to `embedder.embed` at wire-up time.
 */
export type EmbedFn = (text: string) => Promise<Float32Array>;

export interface EmbedderStepMatcherOptions {
  /**
   * Cosine similarity above which `match()` returns the candidate's id.
   * Defaults to `0.85` — deliberately conservative: a false positive means
   * we skip a step that should have re-executed (silent plan drift), which
   * is worse than the false negative (small redundant re-execution).
   */
  threshold?: number;
}

/**
 * Default `StepMatcher` implementation backed by any `embed(text)` function.
 * Uses in-memory cosine similarity — no persistence, no caching (replan is
 * rare enough that per-turn embed latency is negligible).
 */
export class EmbedderStepMatcher implements StepMatcher {
  private readonly threshold: number;

  constructor(
    private readonly embed: EmbedFn,
    opts: EmbedderStepMatcherOptions = {},
  ) {
    this.threshold = opts.threshold ?? 0.85;
  }

  async match(
    queryGoal: string,
    candidates: ReadonlyArray<{ id: string; goal: string }>,
  ): Promise<string | null> {
    if (candidates.length === 0) return null;
    const qv = await this.embed(queryGoal);
    let bestId: string | null = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const cv = await this.embed(c.goal);
      const s = cosineSimilarity(qv, cv);
      if (s > bestScore) {
        bestScore = s;
        bestId = c.id;
      }
    }
    return bestScore >= this.threshold ? bestId : null;
  }
}

/**
 * Cosine similarity between two equal-length `Float32Array` embeddings.
 * Mirrors `packages/memory/src/embedding/hash-embedder.ts` but re-declared
 * locally to avoid the memory dep. Returns 0 when either vector is all-zeros.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
