import type { RoutePhase } from './policy';
import { redactAndClip } from './routing-context';

/**
 * The unit a routing decision is actually about: the work in progress, not the
 * latest sentence. A short follow-up ("yep", "you seem stuck") carries no task
 * of its own, so it is assessed against the episode's goal. A new substantive
 * request restates the work, so it becomes the goal and opens a fresh decision
 * epoch — an unrelated later request must never be judged against an older task.
 */
export interface TaskEpisode {
  id: string;
  /** Latest substantive statement of the work, redacted then clipped here. */
  goal: string;
  /** Goal was clipped; the classifier context must report truncation. */
  goalTruncated?: boolean;
  /** Phase carried across turns; cleared at a phase handoff. */
  phase?: RoutePhase;
  /** Bumped whenever the decision basis changes; participates in the assessment cache key. */
  decisionEpoch: number;
  startedAt: number;
  /** Substantive user requests observed in this episode, including the one that opened it. */
  turns: number;
}

/** A request short enough, or formulaic enough, to carry no task of its own. */
const CONTINUATION = /^(continue|continuar|continua|prossiga|prosseguir|siga|segue|sim|ok|okay|certo|pode seguir|pode continuar|vai em frente|go ahead|proceed|resume|keep going|do it|yes|yep|yeah|go)[.!?\s]*$/i;
const SUBSTANTIVE_WORDS = 8;
const MAX_GOAL_CHARS = 2000;

export function isSubstantive(prompt: string): boolean {
  const text = prompt.trim();
  if (CONTINUATION.test(text)) return false;
  return text.split(/\s+/).filter(Boolean).length >= SUBSTANTIVE_WORDS;
}

/**
 * Advance the episode for this request. A substantive request restates the goal
 * and opens a new decision epoch; anything shorter continues the episode as-is.
 * `phase` is supplied by the caller's persisted routing phase.
 */
export function advanceEpisode(
  previous: TaskEpisode | undefined,
  prompt: string,
  now: number,
  newId: () => string,
): TaskEpisode {
  const substantive = isSubstantive(prompt);
  if (!previous) {
    const goal = redactAndClip(prompt, MAX_GOAL_CHARS);
    return { id: newId(), goal: goal.text, ...(goal.truncated ? { goalTruncated: true } : {}), decisionEpoch: 1, startedAt: now, turns: substantive ? 1 : 0 };
  }
  if (!substantive) return previous;
  const goal = redactAndClip(prompt, MAX_GOAL_CHARS);
  const next: TaskEpisode = { ...previous, goal: goal.text, decisionEpoch: previous.decisionEpoch + 1, turns: previous.turns + 1 };
  if (goal.truncated) next.goalTruncated = true; else delete next.goalTruncated;
  return next;
}

/**
 * A phase boundary (explicit handoff, compaction) keeps the episode's purpose
 * but invalidates decisions that leaned on evidence that is now gone. The goal
 * survives: discarding it left later turns with nothing to be assessed against.
 */
export function advanceDecisionEpoch(previous: TaskEpisode | undefined): TaskEpisode | undefined {
  if (!previous) return undefined;
  const next: TaskEpisode = { ...previous, decisionEpoch: previous.decisionEpoch + 1 };
  delete next.phase;
  return next;
}
