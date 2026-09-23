import type { RoutingContext } from './routing-context';

/** Normalized semantic assessment. `usable:false` entries are cached briefly too, to absorb retries. */
export interface TaskAssessment {
  source: 'jev' | 'cache';
  schemaVersion: 1;
  questionSetVersion: string;
  inputHmac: string;
  evaluatedAt: number;
  phase: { selected: string; probabilities: Record<string, number>; confidence?: number };
  tier: { selected: string; probabilities: Record<string, number>; confidence?: number };
  boundedProbability: number;
  highImpactProbability: number;
  underspecifiedProbability: number;
  reasoningDepth: { score: number; probabilities: Record<string, number> };
  jobFamily: { selected: string; probabilities?: Record<string, number> };
  truncated: boolean;
  usable: boolean;
  unusableReason?: string;
  classifierInputTokens?: number;
  /** Versioned model id that actually answered; an alias can move under us. */
  resolvedModel?: string;
}

interface CacheEntry { assessment: TaskAssessment; expiresAt: number }

const DEFAULT_TTL_MS = 300_000;
/** Failed assessments cache much shorter: just enough to absorb a burst. */
const FAILURE_TTL_MS = 30_000;
/** Bound on live entries; a long session must not grow this map without limit. */
const MAX_ENTRIES = 256;

/** Process-local TTL cache keyed by the redacted-input HMAC. Stores assessments, never raw input. */
export class AssessmentCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) { this.ttlMs = ttlMs; }

  get(key: string, now = Date.now()): TaskAssessment | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) { this.entries.delete(key); return undefined; }
    return entry.assessment;
  }

  put(key: string, assessment: TaskAssessment, now = Date.now()): void {
    const ttl = assessment.usable ? this.ttlMs : FAILURE_TTL_MS;
    this.entries.set(key, { assessment: { ...assessment, source: 'cache' }, expiresAt: now + ttl });
    if (this.entries.size <= MAX_ENTRIES) return;
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    // Map iterates in insertion order, so the oldest survivors go first.
    for (const key of this.entries.keys()) {
      if (this.entries.size <= MAX_ENTRIES) break;
      this.entries.delete(key);
    }
  }

  /** Single-flight: identical concurrent assessments share one classifier call. */
  dedupe<T>(key: string, create: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const wrapped = create().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, wrapped);
    return wrapped;
  }

  invalidate(key: string): void { this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}

/** Enforces: usable assessments cache-hit, changed scope/quality evidence invalidates. */
export function cacheKeyFor(state: RoutingContext, hmac: string, questionSetVersion: string, classifierModel: string, epochId: string): string {
  // Epoch participates: a new substantive task is a fresh decision even if the redacted text matches.
  return `${epochId}:${hmac}:${questionSetVersion}:${classifierModel}:${state.schemaVersion}:${state.observations.confirmedQualityFailures}`;
}
