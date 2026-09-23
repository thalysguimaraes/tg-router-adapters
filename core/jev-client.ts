/**
 * Native TypeSafe System One client.
 *
 * Deliberately dependency-free: a plain `fetch` against POST /v1/systemone.
 * An earlier revision imported the `ai` SDK statically, which made an optional,
 * default-off feature a load-time dependency; when its `zod` peer failed to
 * resolve the whole extension aborted and 9Router model registration went with
 * it. No SDK means that failure mode cannot come back.
 *
 * Fails closed: any missing key, missing rate card, budget refusal, deadline,
 * transport error, or malformed answer returns a typed `ok:false` and the
 * caller MUST continue with deterministic rules.
 */
import type { RoutingContext } from './routing-context';
import { JEV_QUESTIONS, JEV_QUESTION_SET_VERSION } from './jev-questions';
import { questionHash } from './routing-context';
import type { TaskAssessment } from './assessment-cache';
import { isObjectGuard } from './type-guards';

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
/**
 * Pinned version, not the rolling alias. docs.typesafe.ai/models recommends
 * pinning once thresholds are tuned: the alias can change answer distributions
 * without this code changing, which would silently inherit stale calibrated
 * gates. A new alias is evaluated in shadow before it becomes this default.
 */
export const JEVS_CLASSIFIER_MODEL = 'jev-1.13.0';
/** docs.typesafe.ai/models: USD per million input tokens; output tokens are free. */
export const JEV_INPUT_USD_PER_MTOK = 0.042;
/**
 * docs.typesafe.ai/model-jaggedness/jev-1.13: 64k tokens for state + all
 * questions together. The router's own 24 KiB state cap keeps us far below it.
 */
export const JEV_CONTEXT_TOKEN_LIMIT = 64_000;

export interface JevClientOptions {
  /**
   * TypeSafe API key, or a resolver called per assessment. Missing/empty
   * disables the classifier (fail closed to rules). A resolver lets the key
   * appear in the environment after the extension has already loaded.
   */
  apiKey?: string | (() => string | undefined | Promise<string | undefined>);
  /** Endpoint override for contract tests; production default is the real API. */
  endpoint?: string;
  /** Hard wall-clock deadline from dispatch, enforced by a real transport abort. */
  deadlineMs: number;
  /**
   * Conservative upper-bound USD estimate is admitted before dispatch; refusal
   * spends nothing. The returned handle owns the reservation's lifecycle:
   * `dispatched()` is called right before the HTTP call and `settle(usd)` with
   * the cost derived from reported usage. A dispatched request without a
   * usable usage report keeps its liability; nothing here ever releases it.
   */
  admit: (estimatedUsd: number) => { ok: true; dispatched?: () => void; settle?: (actualUsd: number) => void } | { ok: false; reason: string };
  now?: () => number;
  /** Pinned classifier version override; defaults to JEVS_CLASSIFIER_MODEL. */
  model?: string;
  /** Caller cancellation (turn ended); propagated to the HTTP request alongside the deadline. */
  signal?: AbortSignal;
  /** Injectable for tests; production derives the bound from the serialized state. */
  estimateInputTokens?: (state: RoutingContext) => number;
  /** USD per million input tokens from a verified rate card; absent => classifier disabled. */
  inputUsdPerMillion?: number;
  /** Injectable transport for contract tests. */
  fetchImpl?: typeof fetch;
}

export type JevResult =
  | { ok: true; assessment: TaskAssessment; elapsedMs: number }
  | {
      ok: false;
      reason: 'no-key' | 'no-rate-card' | 'budget' | 'timeout' | 'cancelled' | 'transport'
        | 'rate-limited' | 'overloaded' | 'auth' | 'invalid-request' | 'invalid-schema';
      detail?: string;
      elapsedMs: number;
      /** Present on 429/529 when the server supplied retry-after. */
      retryAfterSeconds?: number;
    };

const PHASES = ['lightweight', 'implementation', 'review', 'investigation', 'planning', 'unknown'] as const;
const TIERS = ['mechanical', 'bounded', 'execution', 'complex', 'premium', 'unknown'] as const;
const FAMILIES = ['clerical', 'implementation', 'review', 'architecture', 'investigation', 'visual', 'other'] as const;

const isRecord = isObjectGuard;

/**
 * Jev rounds probabilities to two decimals, so a complete distribution
 * legitimately sums to anything in [0.94, 1.06] for a 6-option question
 * (observed live: capability summed to exactly 0.99, which a 0.01 tolerance
 * rejected at the boundary and silently discarded a good assessment).
 * Tolerance scales with the option count: half a rounding step each, plus
 * float slack.
 */
function distributionSums(values: number[]): boolean {
  const sum = values.reduce((total, value) => total + value, 0);
  return Math.abs(sum - 1) <= 0.005 * values.length + 1e-9;
}

function finiteProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Validates a native Choice answer: selected option, complete distribution
 * summing to 1, and the inline confidence the API returns on every Choice.
 */
function validateChoice(
  answer: unknown,
  allowed: readonly string[],
): { selected: string; probabilities: Record<string, number>; confidence?: number } | undefined {
  if (!isRecord(answer) || answer.type !== 'choice') return undefined;
  if (typeof answer.choice !== 'string' || !allowed.includes(answer.choice)) return undefined;
  const probabilities = answer.probabilities;
  if (!isRecord(probabilities)) return undefined;
  const values: number[] = [];
  for (const key of allowed) {
    const value = probabilities[key];
    if (!finiteProbability(value)) return undefined;
    values.push(value);
  }
  const selected = answer.choice;
  const distribution: Record<string, number> = {};
  allowed.forEach((key, index) => { distribution[key] = values[index]!; });
  if (!distributionSums(values)) return undefined;
  // The selected option must actually be the argmax; otherwise the answer is incoherent.
  if (values.some(value => value > distribution[selected]! + 1e-6)) return undefined;
  const confidence = finiteProbability(answer.confidence) ? answer.confidence : undefined;
  return { selected, probabilities: distribution, ...(confidence !== undefined ? { confidence } : {}) };
}

/** Native Noul answer: `{ type: 'noul', noul: <P(yes)> }`. Carries no confidence by design. */
function validateNoul(answer: unknown): number | undefined {
  if (!isRecord(answer) || answer.type !== 'noul') return undefined;
  return finiteProbability(answer.noul) ? answer.noul : undefined;
}

/** Native Score answer: probability-weighted `score` over levels, plus a legend. */
function validateScore(answer: unknown, maxLevel: number): { score: number; probabilities: Record<string, number>; confidence?: number } | undefined {
  if (!isRecord(answer) || answer.type !== 'score') return undefined;
  if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > maxLevel) return undefined;
  const probabilities = answer.probabilities;
  if (!isRecord(probabilities)) return undefined;
  const levels = Array.from({ length: maxLevel + 1 }, (_, index) => String(index));
  const values: number[] = [];
  for (const key of levels) {
    const value = probabilities[key];
    if (!finiteProbability(value)) return undefined;
    values.push(value);
  }
  const distribution: Record<string, number> = {};
  levels.forEach((key, index) => { distribution[key] = values[index]!; });
  if (!distributionSums(values)) return undefined;
  const mean = levels.reduce((total, key) => total + Number(key) * distribution[key]!, 0);
  // Docs define score as the probability-weighted mean; a mismatch means a shape we do not understand.
  if (Math.abs(mean - answer.score) > 0.05) return undefined;
  const confidence = finiteProbability(answer.confidence) ? answer.confidence : undefined;
  return { score: answer.score, probabilities: distribution, ...(confidence !== undefined ? { confidence } : {}) };
}

/** Byte-based upper bound for the billed input; deliberately pessimistic. */
function defaultEstimateInputTokens(state: RoutingContext): number {
  const stateBytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
  const questionBytes = Buffer.byteLength(JSON.stringify(JEV_QUESTIONS), 'utf8');
  // ~2 bytes/token is conservative for English prose (real ratio is ~4).
  return Math.ceil((stateBytes + questionBytes) / 2) + 256;
}

export function createJevClient(options: JevClientOptions) {
  const now = options.now ?? (() => Date.now());
  const inputTokens = options.estimateInputTokens ?? defaultEstimateInputTokens;
  const endpoint = options.endpoint ?? TYPESAFE_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const classifierModel = options.model ?? JEVS_CLASSIFIER_MODEL;
  return {
    async assess(state: RoutingContext, inputHmac: string): Promise<JevResult> {
      const startedAt = now();
      const elapsed = () => now() - startedAt;
      const apiKey = typeof options.apiKey === 'function' ? await options.apiKey() : options.apiKey;
      if (!apiKey) return { ok: false, reason: 'no-key', elapsedMs: elapsed() };
      // No verified rate card => no verified cost bound => classifier stays disabled.
      if (options.inputUsdPerMillion === undefined || options.inputUsdPerMillion < 0) {
        return { ok: false, reason: 'no-rate-card', elapsedMs: elapsed() };
      }
      const tokens = inputTokens(state);
      const estimatedUsd = (tokens / 1_000_000) * options.inputUsdPerMillion * 1.5;
      const admission = options.admit(estimatedUsd);
      if (!admission.ok) return { ok: false, reason: 'budget', detail: admission.reason, elapsedMs: elapsed() };

      let response: Response;
      admission.dispatched?.();
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: classifierModel, state, questions: JEV_QUESTIONS }),
          // One attempt, one real abort. Retries would need their own reservation.
          signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.deadlineMs)]) : AbortSignal.timeout(options.deadlineMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : 'Unknown';
        const spent = elapsed();
        // Three distinct failures that were previously conflated:
        //  - TimeoutError: our own deadline.
        //  - AbortError: someone cancelled us (in practice omp ending the turn);
        //    reporting it as a timeout sent us chasing a deadline never exceeded.
        //  - anything else (fetch throws TypeError on DNS/connection failure):
        //    a transport failure, not a cancellation.
        // Either way the request may have reached the server, so the
        // reservation stays held.
        const reason = name === 'TimeoutError' || (name === 'AbortError' && spent >= options.deadlineMs * 0.9) ? 'timeout' as const
          : name === 'AbortError' ? 'cancelled' as const
          : 'transport' as const;
        return { ok: false, reason, detail: `${name} after ${spent}ms of ${options.deadlineMs}ms`, elapsedMs: spent };
      }

      if (!response.ok) {
        const retryAfterHeader = Number(response.headers.get('retry-after'));
        const retryAfterSeconds = Number.isFinite(retryAfterHeader) && retryAfterHeader >= 0 ? retryAfterHeader : undefined;
        const reason = response.status === 401 || response.status === 403 ? 'auth'
          : response.status === 422 ? 'invalid-request'
          : response.status === 429 ? 'rate-limited'
          : response.status === 529 ? 'overloaded'
          : 'transport';
        return { ok: false, reason, detail: `http-${response.status}`, elapsedMs: elapsed(), ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) };
      }

      let body: unknown;
      try { body = await response.json(); }
      catch { return { ok: false, reason: 'invalid-schema', detail: 'response was not json', elapsedMs: elapsed() }; }
      // Billing validation is independent of answer validation: a response
      // with unusable answers is still billable when it reports valid usage.
      const usage = isRecord(body) && isRecord(body.usage) ? body.usage : undefined;
      const reportedInputTokens = typeof usage?.input_tokens === 'number' && Number.isInteger(usage.input_tokens) && usage.input_tokens >= 0
        ? usage.input_tokens : undefined;
      if (reportedInputTokens !== undefined) admission.settle?.((reportedInputTokens / 1_000_000) * options.inputUsdPerMillion);
      if (!isRecord(body) || !isRecord(body.answers)) {
        return { ok: false, reason: 'invalid-schema', detail: 'missing answers map', elapsedMs: elapsed() };
      }
      const answers = body.answers;
      const phase = validateChoice(answers.phase, PHASES);
      const tier = validateChoice(answers.capability, TIERS);
      const bounded = validateNoul(answers.bounded);
      const highImpact = validateNoul(answers.highImpact);
      const underspecified = validateNoul(answers.underspecified);
      const reasoningDepth = validateScore(answers.reasoningDepth, JEV_QUESTIONS.reasoningDepth.criteria.length - 1);
      const jobFamily = validateChoice(answers.jobFamily, FAMILIES);
      if (!phase || !tier || bounded === undefined || highImpact === undefined
          || underspecified === undefined || !reasoningDepth || !jobFamily) {
        return { ok: false, reason: 'invalid-schema', detail: 'one or more answers failed validation', elapsedMs: elapsed() };
      }
      return {
        ok: true,
        elapsedMs: elapsed(),
        assessment: {
          source: 'jev',
          schemaVersion: 1,
          questionSetVersion: JEV_QUESTION_SET_VERSION,
          inputHmac,
          evaluatedAt: now(),
          phase,
          tier,
          boundedProbability: bounded,
          highImpactProbability: highImpact,
          underspecifiedProbability: underspecified,
          reasoningDepth,
          jobFamily: { selected: jobFamily.selected, probabilities: jobFamily.probabilities },
          truncated: state.truncated,
          usable: true,
          ...(reportedInputTokens !== undefined ? { classifierInputTokens: reportedInputTokens } : {}),
          ...(typeof body.model === 'string' ? { resolvedModel: body.model } : {}),
        },
      };
    },
    questionHash: () => questionHash(JEV_QUESTIONS),
  };
}
