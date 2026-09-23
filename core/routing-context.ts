import { createHash, createHmac } from 'node:crypto';

/** Semantic task assessment input. Deliberately free of quota, price, credential or roster data. */
export interface RoutingContext {
  schemaVersion: 1;
  taskGoal: string;
  currentUserRequest: string;
  previousPhase?: 'lightweight' | 'implementation' | 'review' | 'investigation' | 'planning';
  scope?: string;
  acceptanceCriteria?: string[];
  recentEvidence?: string[];
  boundary: 'user' | 'child' | 'phase' | 'compaction' | 'provider-failure';
  /**
   * Structured, measured signals. Each field here earned its place against the
   * outcome-labelled corpus; free text is never added to this block.
   */
  observations: {
    hasImages: boolean;
    toolsRequired: boolean;
    changedFilesCount?: number;
    confirmedQualityFailures: number;
    /**
     * The previous assistant turn in this session ended in a provider or
     * tool error. Measured: turns following an error were under-routed
     * (cheap model struggled) 15% of the time vs 4% after a clean turn.
     */
    previousTurnErrored?: boolean;
    /**
     * Number of prior user turns in this session. Measured: the first turn
     * of a session was under-routed 25% of the time vs ~4% for later turns,
     * because there is no established work to lean on.
     */
    priorUserTurns?: number;
    /** Tool calls the previous assistant turn made. Reported for traces; did not separate outcomes on its own. */
    previousTurnToolCalls?: number;
  };
  truncated: boolean;
}

const MAX_STATE_BYTES = 24_576;

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  // Secrets: keyword followed by assignment consumes the assigned value
  // (quoted or bare) so neither key wording nor value leaks. The keyword may
  // itself be quoted (JSON/YAML keys: {"api_key": "…"}, 'token': '…').
  [/(["'`]?)\b(api[_-]?key|api[_-]?secret|secret|password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|bearer|authorization|cookie|session[_-]?id|private[_-]?key|client[_-]?secret)\b\1\s*[:=]\s*(".*?"|'.*?'|`.*?`|[^\s,;)"']+)/gi, '$1$2$1=[REDACTED]'],
  // Prose form: secret keyword directly followed by a quoted value.
  [/\b(api[_-]?key|api[_-]?secret|secret|password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|bearer|authorization|cookie|session[_-]?id|private[_-]?key|client[_-]?secret)\s+(".*?"|'[^']*')/gi, '$1 [REDACTED]'],
  // Env-style compound names (R2_SECRET_ACCESS_KEY=..., MY_APP_TOKEN=...). The
  // keyword regex above needs the keyword as a whole word; compound names
  // embed it. Found in a real session where a pasted .env slipped through.
  [/(["'`]?)\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\1\s*[=:]\s*(".*?"|'.*?'|[^\s,;)"']+)/g, '$1$2$1=[REDACTED]'],
  [/\b(sk|pk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED-KEY]'],
  // Opaque prefixed keys (apikey_…, ts_…, key_…, xoxb-…) with a long random tail.
  [/\b(?:api[_-]?key|apikey|ts|key|xox[a-z])[_-][A-Za-z0-9_-]{20,}\b/gi, '[REDACTED-KEY]'],
  [/\bghp_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED-KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED-KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED-JWT]'],
  // Bearer schemes.
  [/\bBearer\s+\S+/gi, 'Bearer [REDACTED]'],
  // 1Password references.
  [/\bop:\/\/[^\s"']+/g, 'op://[REDACTED]'],
  // Credentials in URLs.
  [/(\w+):\/\/[^/\s:@"]+:[^/\s@"]+@/g, '$1://[REDACTED]@'],
  // Home and repo absolute paths keep only the final two segments.
  [/(?:\/(?:Users|home)\/[\w.-]+)(?:\/[\w.-]+)*/g, '[PATH]'],
];

export function redactText(text: string): string {
  let value = text;
  for (const [pattern, replacement] of REDACTION_PATTERNS) value = value.replace(pattern, replacement);
  return value;
}

/**
 * The one pipeline for untrusted text: redact on the intact string, then clip.
 * Clipping first can cut a credential's closing quote so the redactor no
 * longer recognizes it. Every upstream clipper must go through here.
 */
export function redactAndClip(text: string, maxChars: number): { text: string; truncated: boolean } {
  const value = redactText(text);
  return value.length <= maxChars ? { text: value, truncated: false } : { text: value.slice(0, maxChars), truncated: true };
}

/**
 * Assemble a bounded, redacted RoutingContext from untrusted task text.
 * Truncation marks the context; a truncated assessment can never authorize a downgrade.
 */
export function buildRoutingContext(parts: {
  taskGoal: string;
  currentUserRequest: string;
  previousPhase?: RoutingContext['previousPhase'];
  scope?: string;
  acceptanceCriteria?: string[];
  recentEvidence?: string[];
  boundary: RoutingContext['boundary'];
  hasImages: boolean;
  toolsRequired: boolean;
  changedFilesCount?: number;
  confirmedQualityFailures: number;
  previousTurnErrored?: boolean;
  priorUserTurns?: number;
  previousTurnToolCalls?: number;
  /** Clipping that already happened upstream (episode goal storage). */
  upstreamTruncated?: boolean;
}): RoutingContext {
  const goalBudget = 4000;
  const requestBudget = 4000;
  const evidenceBudget = 600;
  const perCriterionBudget = 400;
  const criterionCount = 10;
  const evidenceCount = 6;
  const clip = redactAndClip;

  const goal = clip(parts.taskGoal, goalBudget);
  const request = clip(parts.currentUserRequest, requestBudget);
  const evidence = (parts.recentEvidence ?? []).slice(0, evidenceCount).map(entry => clip(entry, evidenceBudget));
  const criteria = (parts.acceptanceCriteria ?? []).slice(0, criterionCount).map(entry => clip(entry, perCriterionBudget));
  const scope = parts.scope === undefined ? undefined : clip(parts.scope, 1000);

  let context: RoutingContext = {
    schemaVersion: 1,
    taskGoal: goal.text,
    currentUserRequest: request.text,
    ...(parts.previousPhase ? { previousPhase: parts.previousPhase } : {}),
    ...(scope ? { scope: scope.text } : {}),
    ...(criteria.length ? { acceptanceCriteria: criteria.map(entry => entry.text) } : {}),
    ...(evidence.length ? { recentEvidence: evidence.map(entry => entry.text) } : {}),
    boundary: parts.boundary,
    observations: {
      hasImages: parts.hasImages,
      toolsRequired: parts.toolsRequired,
      ...(parts.changedFilesCount !== undefined ? { changedFilesCount: parts.changedFilesCount } : {}),
      confirmedQualityFailures: parts.confirmedQualityFailures,
      ...(parts.previousTurnErrored !== undefined ? { previousTurnErrored: parts.previousTurnErrored } : {}),
      ...(parts.priorUserTurns !== undefined ? { priorUserTurns: parts.priorUserTurns } : {}),
      ...(parts.previousTurnToolCalls !== undefined ? { previousTurnToolCalls: parts.previousTurnToolCalls } : {}),
    },
    truncated: parts.upstreamTruncated === true
      || goal.truncated || request.truncated || scope?.truncated === true
      || evidence.some(entry => entry.truncated) || criteria.some(entry => entry.truncated)
      || (parts.acceptanceCriteria?.length ?? 0) > criterionCount
      || (parts.recentEvidence?.length ?? 0) > evidenceCount,
  };

  // Hard size ceiling: drop optional evidence first, then trim the goal.
  while (Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_STATE_BYTES) {
    const evidenceCount = context.recentEvidence?.length ?? 0;
    const criteriaCount = context.acceptanceCriteria?.length ?? 0;
    if (evidenceCount > 0) {
      context = { ...context, recentEvidence: context.recentEvidence!.slice(0, -1), truncated: true };
    } else if (criteriaCount > 1) {
      context = { ...context, acceptanceCriteria: context.acceptanceCriteria!.slice(0, -1), truncated: true };
    } else {
      context = { ...context, taskGoal: context.taskGoal.slice(0, Math.floor(context.taskGoal.length * 0.8)), truncated: true };
      if (context.taskGoal.length === 0) break;
    }
  }
  return context;
}

/** Schema + questions participate in the cache key: a rubric change invalidates cached assessments. */
export const JEV_SCHEMA_VERSION = 1;
export const JEV_QUESTION_SET_VERSION = 'jev-questions-1';

/** Keyed hash of the redacted state for caching and traces. Never reverses to the input. */
export function assessmentCacheKey(parts: {
  state: RoutingContext;
  schemaVersion: number;
  questionSetVersion: string;
  classifierModel: string;
  hmacKey: string;
}): string {
  const payload = JSON.stringify({
    s: parts.state,
    v: parts.schemaVersion,
    q: parts.questionSetVersion,
    m: parts.classifierModel,
  });
  return createHmac('sha256', parts.hmacKey).update(payload).digest('hex');
}

/** Cheap equality hash for tracing identical inputs without an HMAC key. */
export function questionHash(questions: unknown): string {
  return createHash('sha256').update(JSON.stringify(questions)).digest('hex').slice(0, 16);
}

export { MAX_STATE_BYTES };
