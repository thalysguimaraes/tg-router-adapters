/** Personal routing policy. Pure data in/out; no auth, I/O, provider or classifier calls. */
export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type RouteTier = "mechanical" | "bounded" | "execution" | "complex" | "premium";
/** Authoritative max age for a positive quota observation. Must stay <= the usage adapter's stale cutoff. */
export const QUOTA_MAX_AGE_MS = 180_000;
export type RoutePhase = "lightweight" | "implementation" | "review" | "investigation" | "planning";
export type QuotaState = "healthy" | "reserve" | "depleted" | "unknown";

/** Integration passes every applicable window, scoped to an eligible native account. */
export interface QuotaWindow {
  id: string;
  /**
   * Stable identity of the underlying allowance, when the integration can name
   * it (`<provider>:<accountHash>:<windowId>`). Two models drawing on the SAME
   * allowance are not independent capacity: Fable and Sonnet on one Claude
   * subscription share `weekly-7d`, so spending one spends the other. Absent
   * means "not known to be shared", never "known independent".
   */
  sharedKey?: string;
  remainingFraction?: number;
  usedFraction?: number;
  resetsAt?: number;
  reserveFraction?: number;
  /** Explicit provider status, when present, wins over a rounded usage percentage. */
  exhausted?: boolean;
  /** resetsAt - observedAt at capture time; undefined when either is unknown. */
  horizonMs?: number;
}
export interface QuotaAccount {
  connectionId: string;
  priority: number;
  state: QuotaState;
  /** min over windows of remainingFraction / max(1, hoursToReset). -1 when unknown. */
  pressure: number;
  /** modelLock_<model> expiry > now for the queried model. */
  locked: boolean;
}
export interface QuotaSnapshot {
  observedAt: number;
  state?: QuotaState;
  windows?: QuotaWindow[];
  accounts?: QuotaAccount[];
}
export interface RouteModel {
  ref: string;
  /**
   * Stable provider identity used for capability and preference decisions.
   * `ref` remains the concrete transport/model reference returned in a
   * decision (for example, `9router/cx/gpt-5.6-sol`).
   */
  canonicalRef?: string;
  /** A gateway route is a transport choice, not a second native account. */
  gateway?: boolean;
  authenticated: boolean;
  contextWindow: number;
  supportsImages: boolean;
  supportsTools: boolean;
  supportedEfforts?: Effort[];
  validated?: { tools?: boolean; vision?: boolean; reasoning?: boolean };
  quota?: QuotaSnapshot;
  /** Explicit task qualification for extra models; unrelated benchmark scores are not used. */
  qualityTiers?: RouteTier[];
  payg?: boolean;
  /**
   * Conservative USD upper bound for THIS task on this paid route, from live
   * rates and the request's own token bounds. Paid candidates share one cost
   * class and carry no quota window, so without this they were ordered by a
   * hardcoded preference list and price was ignored entirely. Absent means
   * "price unknown", which never ranks ahead of a known price.
   */
  taskCostUsd?: number;
}
export interface CurrentRoute {
  model: string;
  effort?: Effort;
  tier?: RouteTier;
  phase?: RoutePhase;
}
export interface RouteInput {
  prompt: string;
  /** Epoch milliseconds; callers should supply their observation clock. */
  now?: number;
  models: RouteModel[];
  current?: CurrentRoute;
  previous?: { tier: RouteTier; phase: RoutePhase };
  /**
   * Hard floor a spawned child inherits from its parent's assignment. Raises
   * an uncertain or under-classified prompt; never lowers an explicit one.
   * Not a user command and not persisted across handoffs.
   */
  childFloor?: { tier: RouteTier; phase: RoutePhase };
  /** An explicit user choice, never an inferred provider/model name in task text. */
  manualPin?: { model: string; effort?: Effort };
  contextTokens: number;
  /** False only when integration proves no prior assistant work exists. */
  hasWorkContext?: boolean;
  outputMarginTokens?: number;
  needsImages?: boolean;
  needsTools?: boolean;
  boundary?: "user" | "child" | "phase" | "compaction" | "provider-failure" | "tool";
  task?: { bounded?: boolean; acceptanceDefined?: boolean; highValue?: boolean; failedQualityChecks?: number };
  promotion?: { active: boolean; confirmedAt: number };
  paidFallback?: { authorized: boolean; budgetReserved: boolean; allowedModels: string[] };
  /** A visible work-state handoff exists before leaving Fable's reasoning format. */
  handoffReady?: boolean;
  /**
   * Resolved classification for THIS request (rules + semantic evidence),
   * computed by the caller from `classifyTask(input)` and
   * `resolveClassification`. When present it replaces the internal rules
   * classification; hard floors, pins and quality escalation still apply.
   */
  classification?: { tier: RouteTier; phase: RoutePhase };
  quotaMaxAgeMs?: number;
  promotionMaxAgeMs?: number;
  /** Live canonical models already held by parent + siblings when boundary === "child". */
  siblings?: Array<{ canonicalRef: string; count: number }>;
  /**
   * Agents observed to be mid-task against a shared allowance, keyed by
   * `QuotaWindow.sharedKey`. Sibling counts are provider-level and cannot see
   * this: two agents on DIFFERENT models of the same subscription consume one
   * window. Advisory — the provider's own accounting stays authoritative.
   */
  inFlightByWindow?: Record<string, number>;
}
export interface RouteDecision {
  action: "select" | "preserve" | "unavailable";
  model?: string;
  effort?: Effort;
  tier: RouteTier;
  phase: RoutePhase;
  reason: string;
  quotaState?: QuotaState;
  rejected: Array<{ model: string; reason: string }>;
}

/** Map OMP's native subagent model roles to a routing floor for the child. */
export function childFloorFor(value: unknown): { tier: RouteTier; phase: RoutePhase } | undefined {
  if (typeof value !== "string") return undefined;
  const alias = value.trim().toLowerCase().replace(/^@/, "");
  switch (alias) {
    case "task": return { tier: "bounded", phase: "implementation" };
    case "plan": return { tier: "complex", phase: "planning" };
    case "revisao": return { tier: "execution", phase: "review" };
    case "pesquisa": return { tier: "complex", phase: "investigation" };
    default: return undefined;
  }
}

/** Normalized semantic assessment produced by the classifier adapter or cache. */
export interface SemanticAssessment {
  phase?: { selected: string; confidence?: number };
  tier?: { selected: string; probabilities: Record<string, number>; confidence?: number };
  boundedProbability?: number;
  highImpactProbability?: number;
  underspecifiedProbability?: number;
  truncated?: boolean;
  usable?: boolean;
}

/** Rollout modes for the semantic classifier. `off` never calls it. */
export type SemanticMode = "off" | "shadow" | "assisted" | "calibrated";

/**
 * Gates for semantic tier changes.
 *
 * CALIBRATED 2026-09-18 against 160 real turns from session-corpus.jsonl,
 * scored live by jev-1.13 (`bun run calibrate`, raw scores in
 * personal-router/calibration.json). The result was negative and is recorded
 * here so it is not re-litigated:
 *
 *   Two labelled classes were compared — turns where a cheap worker model was
 *   demonstrably sufficient, and turns on a premium model where the
 *   deterministic rules independently agreed premium was warranted. Jev does
 *   not separate them. 41% of premium-warranted turns were judged `bounded`,
 *   while 63% of cheap-sufficient turns were judged `execution` or higher.
 *   Both classes concentrate in the same cell (`rules=complex jev=bounded`
 *   held 13 cheap and 33 premium turns). No threshold on confidence or
 *   higher-tier mass admits meaningful cheap work: fully open
 *   (mass <= 1.0, confidence >= 0.5) still admitted only 5 of 80.
 *
 *   The cause is visible in the prompts, and it is not a model defect. Real
 *   turns are conversational continuations whose difficulty lives in the
 *   accumulated session, not the sentence ("o board 4 não precisa de pills",
 *   "align the text of the right block to the right"). Jev reads the text
 *   literally and correctly, and the text understates the work.
 *
 * Consequently `calibrated` mode stays unreachable from the user surface and
 * semantic DOWNGRADES are not enabled. Jev's demonstrated value is phase
 * clarification and resolving short follow-ups against a persistent task
 * goal, both of which only ever raise or clarify. The over-routing problem
 * (69% of turns classify `complex` via the no-keyword default) belongs to the
 * deterministic classifier and is fixable there with the same corpus.
 */
export const SEMANTIC_GATES = {
  overrideTopProbability: 0.80,
  overrideConfidence: 0.80,
  /** A phase clarification below this confidence is a no-op, not a relabel. */
  phaseConfidence: 0.70,
  downgradeTopProbability: 0.90,
  downgradeConfidence: 0.90,
  downgradeMargin: 0.20,
  downgradeMaxHigherTierMass: 0.01,
} as const;

export interface ResolveAssessmentInput {
  assessment: SemanticAssessment | undefined;
  rulesClassification: { tier: RouteTier; phase: RoutePhase };
  mode: SemanticMode;
  /** A spawned child's inherited floor; semantics may raise but never cross it. */
  floorTier?: RouteTier;
  /** True when a child's inherited phase must not be reinterpreted. */
  floorLocksPhase?: boolean;
  /** The previous assistant turn errored. Measured 4x struggle rate; blocks downgrades. */
  previousTurnErrored?: boolean;
  /** Prior user turns in the session; 0 means first turn. Measured 6x struggle rate; blocks downgrades. */
  priorUserTurns?: number;
  highValue?: boolean;
  failedQualityChecks?: number;
}

/**
 * Pure combination of rule classification with semantic evidence.
 * Hard rules outrank semantics; uncertainty degrades to the rule baseline;
 * downgrades additionally require the calibrated mode and strict gates.
 */
export function resolveClassification(input: ResolveAssessmentInput): { tier: RouteTier; phase: RoutePhase; source: "rules" | "semantic-assisted" | "semantic-downgrade"; reason: string } {
  const { tier, phase } = input.rulesClassification;
  const assessment = input.assessment;
  if (!assessment || assessment.usable === false || input.mode === "off") {
    return { tier, phase, source: "rules", reason: input.mode === "off" ? "Semantic routing is off." : "No usable semantic assessment; rules baseline applies." };
  }
  const floorRank = input.floorTier ? Math.max(rank(tier), rank(input.floorTier)) : rank(tier);
  // Phase constraints hold in EVERY branch: a locked child phase and a rules
  // `review` phase are never reinterpreted (review routing is Fable/Astra
  // only, so relabeling it would relax eligibility without lowering the tier).
  const resolvedPhase = constrainedPhase(assessment, phase, input.floorLocksPhase === true);
  if (input.mode === "assisted") {
    // Assisted mode: semantic phase clarification and upward-only tier moves.
    const semanticTier = assessment.tier ? safeTier(assessment.tier.selected) : undefined;
    if (semanticTier && rank(semanticTier) > floorRank && gatesPass(assessment.tier!, SEMANTIC_GATES.overrideTopProbability, SEMANTIC_GATES.overrideConfidence)) {
      return { tier: semanticTier, phase: resolvedPhase, source: "semantic-assisted", reason: `Semantic assessment raised the capability floor (${tier} -> ${semanticTier}).` };
    }
    if (resolvedPhase !== phase) {
      return { tier, phase: resolvedPhase, source: "semantic-assisted", reason: `Semantic phase clarification: ${phase} -> ${resolvedPhase}.` };
    }
    return { tier, phase, source: "rules", reason: "Assisted mode keeps the rules baseline." };
  }
  if (input.mode === "calibrated") {
    // safeTier returns the "unknown" label as a tier; treat it as unusable.
    const semanticTierRaw = assessment.tier ? safeTier(assessment.tier.selected) : undefined;
    const semanticTierObject = assessment.tier;
    if (!semanticTierRaw || semanticTierRaw === ("unknown" as RouteTier) || !semanticTierObject) return { tier, phase, source: "rules", reason: "No usable semantic tier; rules baseline applies." };
    const semanticTier: RouteTier = semanticTierRaw;
    // Review never downgrades. Two reasons, one of them measured:
    // 1. Automatic review routing is restricted to Fable/Astra, so dropping
    //    the tier would contradict that restriction.
    // 2. Observed on jev-1.13 (2026-09-17): "review whether this payment-state
    //    transition can double-charge" scores highImpact ~0.30, because a
    //    review does not itself move money. The model answers literally and is
    //    not wrong, so the impact gate alone cannot protect review work. Real
    //    mutations (deleting production rows, changing token expiry, rotating
    //    live keys) score 0.94-0.98 and the 0.5 gate catches those decisively.
    const reviewPhase = assessment.phase?.selected === "review" || input.rulesClassification.phase === "review";
    // Session signals measured against the outcome corpus (scripts/relabel.ts):
    // a cheap model struggled 15% of the time on the turn after an error vs 4%
    // after a clean one, and 25% on a session's first turn vs ~4% later. Both
    // are deterministic and block a downgrade regardless of what Jev says.
    const downgradeGuard =
      input.highValue === true ? "high-value work never downgrades"
      : (input.failedQualityChecks ?? 0) > 0 ? "unresolved quality failure blocks downgrade"
      : input.previousTurnErrored === true ? "previous turn errored; struggle rate is 4x after an error"
      : input.priorUserTurns === 0 ? "first turn of a session; no established work to lean on"
      : (assessment.highImpactProbability ?? 0) >= 0.5 ? "high-impact signal blocks downgrade"
      : reviewPhase ? "review work never downgrades"
      : (assessment.underspecifiedProbability ?? 0) >= 0.5 || assessment.truncated === true ? "insufficient context blocks downgrade"
      : undefined;
    if (downgradeGuard) return { tier, phase, source: "rules", reason: `Calibrated mode kept ${tier}: ${downgradeGuard}.` };
    if (rank(semanticTier) < floorRank) {
      const higherTierMass = TIERS.filter(t => rank(t) > rank(semanticTier)).reduce((sum, t) => sum + (semanticTierObject.probabilities[t] ?? 0), 0);
      const top = topProbability(semanticTierObject.probabilities, semanticTier);
      const confidence = semanticTierObject.confidence ?? 0;
      if (top >= SEMANTIC_GATES.downgradeTopProbability && confidence >= SEMANTIC_GATES.downgradeConfidence &&
          top - secondProbability(semanticTierObject.probabilities, semanticTier) >= SEMANTIC_GATES.downgradeMargin &&
          higherTierMass <= SEMANTIC_GATES.downgradeMaxHigherTierMass) {
        // A downgrade may land anywhere from the rules tier down to the role
        // minimum; without a role minimum the semantic tier itself is the floor.
        const floor = input.floorTier && rank(input.floorTier) > rank(semanticTier) ? input.floorTier : semanticTier;
        return { tier: floor, phase: resolvedPhase, source: rank(floor) < rank(tier) ? "semantic-downgrade" : "rules", reason: rank(floor) < rank(tier) ? `Calibrated semantic downgrade (${tier} -> ${floor}) passed all uncertainty gates; child floor honored.` : `Rules tier ${tier} kept; semantic tier ${semanticTier} sits at or above the floor.` };
      }
      return { tier, phase, source: "rules", reason: "Semantic downgrade failed an uncertainty gate; rules baseline applies." };
    }
    if (rank(semanticTier) > floorRank && gatesPass(semanticTierObject, SEMANTIC_GATES.overrideTopProbability, SEMANTIC_GATES.overrideConfidence)) {
      return { tier: semanticTier, phase: resolvedPhase, source: "semantic-assisted", reason: `Semantic assessment raised the capability floor (${tier} -> ${semanticTier}).` };
    }
    if (resolvedPhase !== phase) {
      return { tier, phase: resolvedPhase, source: "semantic-assisted", reason: `Semantic phase clarification: ${phase} -> ${resolvedPhase}.` };
    }
    return { tier, phase, source: "rules", reason: "Calibrated mode kept the rules baseline." };
  }
  // shadow: never changes the decision; caller records the comparison.
  return { tier, phase, source: "rules", reason: "Shadow mode executes the rules baseline." };
}

function safeTier(value: string): RouteTier | undefined {
  return (TIERS as readonly string[]).includes(value) ? value as RouteTier : undefined;
}
function safePhase(value: string): RoutePhase | undefined {
  return (["lightweight", "implementation", "review", "investigation", "planning"] as readonly string[]).includes(value) ? value as RoutePhase : undefined;
}
function constrainedPhase(assessment: SemanticAssessment, rulesPhase: RoutePhase, locked: boolean): RoutePhase {
  if (locked || rulesPhase === "review") return rulesPhase;
  const semanticPhase = safePhase(assessment.phase?.selected ?? "");
  if (!semanticPhase || (assessment.phase?.confidence ?? 0) < SEMANTIC_GATES.phaseConfidence) return rulesPhase;
  return semanticPhase;
}
function gatesPass(tier: { selected: string; confidence?: number; probabilities: Record<string, number> }, topProbabilityGate: number, confidenceGate: number): boolean {
  return topProbability(tier.probabilities, tier.selected) >= topProbabilityGate && (tier.confidence ?? 0) >= confidenceGate;
}
function topProbability(probabilities: Record<string, number>, selected: string): number {
  return probabilities[selected] ?? 0;
}
function secondProbability(probabilities: Record<string, number>, selected: string): number {
  const rest = Object.entries(probabilities).filter(([key]) => key !== selected).map(([, value]) => value);
  return rest.length ? Math.max(...rest) : 0;
}

export const MODELS = {
  astra: "openai-codex/gpt-6-astra",
  sol: "openai-codex/gpt-5.6-sol",
  luna: "openai-codex/gpt-5.6-luna",
  deepseek: "opencode-go/deepseek-v4.1-flash",
  glm: "opencode-go/glm-5.3-flash",
  fable: "anthropic/claude-fable-5-1",
  sonnet: "anthropic/claude-sonnet-5",
  opus: "anthropic/claude-opus-5",
} as const;

const TIERS: RouteTier[] = ["mechanical", "bounded", "execution", "complex", "premium"];
const EFFORTS: Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
// This is the reviewed personal task loadout, not a universal ranking of model intelligence.
const QUALIFICATIONS: Record<string, RouteTier[]> = {
  [MODELS.luna]: ["mechanical"],
  [MODELS.deepseek]: ["mechanical", "bounded"],
  [MODELS.glm]: ["mechanical", "bounded"],
  [MODELS.sol]: ["mechanical", "bounded", "execution"],
  [MODELS.sonnet]: ["mechanical", "bounded", "execution"],
  [MODELS.astra]: TIERS,
  [MODELS.opus]: TIERS,
  [MODELS.fable]: TIERS,
};

interface Classification { tier: RouteTier; phase: RoutePhase; uncertain: boolean; continuation: boolean; phaseLocked?: boolean }
const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const rank = (tier: RouteTier) => TIERS.indexOf(tier);
const canonicalModelRef = (model: RouteModel): string => model.canonicalRef ?? model.ref;
const isGatewayModel = (model: RouteModel): boolean => model.gateway === true || model.ref.startsWith("9router/");
const finiteFraction = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1;
const fresh = (at: number, now: number, maxAge: number) =>
  Number.isFinite(at) && at <= now && now - at <= maxAge;

// Narrow lexical exceptions for bounded implementation contracts. Never discard
// an entire negated clause: it may also contain a separate positive risk request.
function implementationCapabilityText(text: string): string {
  return text
    .replace(/\bunsupported diagnostics\b/g, " ")
    .replace(/\bdiagnosticos nao suportados\b/g, " ")
    .replace(/\breturn (?:owned files and )?(?:the )?critical invariants?\b/g, " ")
    .replace(/\b(?:retorne|retornar) (?:as )?invariantes criticas\b/g, " ")
    .replace(/\b(?:no|without) production (?:install(?:ation)?|changes?|deployments?)\b/g, " ")
    .replace(/\bdo not (?:deploy|install) (?:to |in )?production\b/g, " ")
    .replace(/\bsem (?:alteracoes|instalacao|implantacao) em producao\b/g, " ")
    .replace(/\bnao (?:implante|instale|altere) (?:em |a )?producao\b/g, " ");
}

function classify(input: RouteInput): Classification {
  const text = normalize(input.prompt).trim();
  // A child spawned as an implementation worker with an explicit contract may
  // have its capability text lightly de-noised of contract boilerplate.
  const boundedImplementation = input.childFloor?.phase === "implementation" && input.task?.bounded === true && input.task.acceptanceDefined === true;
  const capabilityText = boundedImplementation ? implementationCapabilityText(text) : text;
  const prior = (input.previous?.phase ? input.previous : undefined) ?? (input.current?.tier && input.current.phase
    ? { tier: input.current.tier, phase: input.current.phase } : undefined);
  const continuing = /^(continue|continuar|continua|prossiga|prosseguir|siga|segue|sim|ok|okay|certo|pode seguir|pode continuar|vai em frente|go ahead|proceed|resume|keep going|do it)[.!?\s]*$/.test(text);
  const planning = /\b(plan|planning|planej\w*|arquitet\w*|architecture|design decisions|trade.?offs?|estrateg\w*|strategy)\b/.test(text);
  const investigationPattern = /\b(investig\w*|diagnos\w*|research\w*|pesquis\w*|root cause|causa raiz|analise|analisar|analyze|analysis|debug\w*)\b/;
  const riskyPattern = /\b(security|seguranca|migrac\w*|migration|production|producao|autentic\w*|authentication|concorrencia|concurrency|race condition|data loss|perda de dados)\b/;
  const difficultPattern = /\b(complex\w*|ambigu\w*|profund\w*|deep|dificil|hard|critico|critical|sem hipotese|unknown root cause|sem causa|contradit\w*|nao converge|sintese extensa)\b/;
  const investigation = investigationPattern.test(capabilityText);
  const risky = riskyPattern.test(capabilityText);
  const difficult = difficultPattern.test(capabilityText);
  const visualJudgment = /\b(redesign|critique|critica visual|direcao de arte|art direction|visual judgment|polimento visual|design system|identidade visual)\b/.test(text);
  const review = /\b(review|revis\w*|rever|auditar|audit)\b/.test(text);
  const coding = /\b(implement\w*|implemente|corrig\w*|corrija|fix|refator\w*|refactor\w*|codig\w*|code|test\w*|patch|bug|adicione|add|edite|edit|alter\w*|change|atualiz\w*|update)\b/.test(text);
  const mechanicalWords = /\b(resum\w*|summari[sz]\w*|format\w*|reformat\w*|renome\w*|rename|list|liste|listar|listing|extra\w*|extract|localiz\w*|find file|which file|onde fica|traduz\w*|translate|changelog|typo|ortograf\w*)\b/.test(text);
  /**
   * A delegation brief: long and structured, with goal/acceptance scaffolding
   * or embedded tags. Structure beats vocabulary here — measured over 381
   * turns where a cheap model was actually tried, briefs finished cleanly 31%
   * of the time against 69% for everything else, with 5x the tool calls
   * (p50 69 vs 14). This is what made `mechanical` keywords look unsafe: a
   * 200-line spec that happens to contain the word "list" is not a listing
   * task. Excluding briefs takes mechanical's cheap success from 39% to 53%.
   */
  const words = text.split(/\s+/).filter(Boolean).length;
  const headingCount = (input.prompt.match(/(^|\n)#{1,3} \S/g) ?? []).length;
  const briefScaffold = /(^|\n)#{0,3}\s*(goal|ownership|acceptance|content|contexto|escopo|scope|non-goals?|deliverable|constraints)\b/i.test(input.prompt);
  const embeddedTags = /<instructions>|<file name=|<\/[a-z-]+>/.test(input.prompt);
  const delegationBriefShape = words >= 80 && (headingCount >= 2 || briefScaffold || embeddedTags);
  // A brief is never a mechanical task, however its words read.
  const mechanical = mechanicalWords && !delegationBriefShape;
  // Session and repository operations: deploy, commit, push, reconcile, close
  // the worktree, move the issue. Measured over 2,839 real turns
  // (scripts/relabel.ts, outcome labels): of the no-keyword prompts that fell
  // to the `complex` default, these carried the highest share of turns a
  // cheap model finished cleanly (20% vs a 13% base rate) and a BELOW-base
  // share of turns where a cheap model struggled (5% vs 8%). They need tool
  // discipline, not reasoning depth; a worker handles them at least as well.
  //
  // Verbs only. Nouns like "worktree" or "branch" also appear as constraints
  // inside large delegation briefs ("work only in this worktree/branch"),
  // which the replay showed being pushed down; those are the opposite of a
  // small op and are excluded explicitly below.
  // Phrase-level brief markers, kept alongside the structural test: a short
  // lane assignment carries the same "do not treat this as a small op" weight.
  const delegationBrief = delegationBriefShape || /\b(voce e a lane|you are the .{0,40}(?:owner|lane|worker)|leia, nesta ordem|read, in this order|siga-os integralmente|follow (?:them|it) (?:integrally|in full))\b/.test(text);
  const sessionOps = !delegationBrief && /\b(deploy\w*|commit\w*|push|pull|merge|rebase|stash|reconcil\w*|clos(?:e|ing) (?:the )?(?:session|worktree)|finish(?:ing)? (?:the )?session|clean(?:up)? (?:the )?worktree|move (?:the )?issue|check linear|git status|is git|reload|restart|reinicia\w*|sobe|suba|smoke)\b/.test(text);
  // A pasted stack trace or code block with no other signal is a debugging
  // request. Measured: 14% of the turns where a cheap model STRUGGLED carried
  // pasted code, against 1% of the turns it finished cleanly. This is the
  // strongest under-routing signal in the corpus and must not fall to a
  // worker. Uses the raw prompt: normalization strips nothing relevant here.
  const pastedCode = /```|\n\s+at [\w.$<>]+ \(|Error(?:Type|Message)?:|Traceback \(most recent call last\)|^\s*(?:\d+ \|)/m.test(input.prompt);
  const explicitTask = planning || investigation || risky || difficult || visualJudgment || review || coding || mechanical || sessionOps || pastedCode || delegationBriefShape;
  const shortFollowup = !explicitTask && text.split(/\s+/).filter(Boolean).length <= 10;
  if (prior && (continuing || shortFollowup)) return { ...prior, uncertain: false, continuation: true };

  let result: Classification;
  if ((difficult && (planning || investigation || review)) || visualJudgment) {
    result = { tier: "premium", phase: planning || visualJudgment ? "planning" : review ? "review" : "investigation", uncertain: false, continuation: false };
  } else if (risky || planning || investigation || difficult) {
    result = { tier: "complex", phase: planning ? "planning" : "investigation", uncertain: false, continuation: false };
  } else if (review) {
    result = { tier: "execution", phase: "review", uncertain: false, continuation: false };
  } else if (input.task?.bounded && input.task.acceptanceDefined && coding && !delegationBriefShape) {
    result = { tier: "bounded", phase: "implementation", uncertain: false, continuation: false };
  } else if (delegationBriefShape) {
    // Measured: 31% cheap success against 69% for everything else, p50 69 tool
    // calls against 14. A brief is sustained multi-step work whatever its
    // vocabulary suggests, so it floors at execution rather than a worker tier.
    result = { tier: "execution", phase: "implementation", uncertain: false, continuation: false };
  } else if (mechanical) {
    result = { tier: "mechanical", phase: "lightweight", uncertain: false, continuation: false };
  } else if (coding) {
    // Ordinary implementation is an approved bounded worker task. A task
    // does not need a child-only acceptance contract to use GLM/DeepSeek.
    result = { tier: "bounded", phase: "implementation", uncertain: false, continuation: false };
  } else if (sessionOps) {
    result = { tier: "bounded", phase: "implementation", uncertain: false, continuation: false };
  } else if (pastedCode) {
    result = { tier: "complex", phase: "investigation", uncertain: false, continuation: false };
  } else {
    // No signal at all. Previously this always reset to complex/investigation,
    // which put 69% of real turns in the premium class. With an established
    // phase the prior is the better guess; without one, complex remains the
    // safe floor because we know nothing. Semantic assistance can still raise.
    result = { tier: prior?.tier ?? "complex", phase: prior?.phase ?? "investigation", uncertain: true, continuation: false };
  }
  // A child floor is inherited from the parent's assignment, not chosen by a
  // user. It raises an uncertain or under-classified prompt to what the parent
  // asked for, and supplies the phase when the prompt has none of its own. It
  // never lowers an explicitly classified capability: a research child that
  // is told to implement something is still doing implementation.
  const explicitCapabilityPhase = planning || investigation || risky || difficult || visualJudgment || review || coding;
  const floor = input.childFloor;
  if (floor && !prior) {
    if (result.uncertain && !explicitCapabilityPhase) {
      result = { tier: floor.tier, phase: floor.phase, uncertain: false, continuation: false };
    } else if (rank(result.tier) < rank(floor.tier)) {
      result = { ...result, tier: floor.tier, phase: explicitCapabilityPhase ? result.phase : floor.phase, uncertain: false };
    } else if (!explicitCapabilityPhase) {
      result = { ...result, phase: floor.phase, uncertain: false };
    }
  }
  if (prior?.phase === "planning" && rank(result.tier) < rank(prior.tier) && !input.handoffReady &&
      input.boundary !== "phase" && input.boundary !== "compaction" && input.boundary !== "child") {
    return { ...prior, uncertain: false, continuation: true, phaseLocked: true };
  }
  return result;
}

/** The deterministic rules classification of this request, for the caller to combine with semantic evidence. */
export function classifyTask(input: RouteInput): { tier: RouteTier; phase: RoutePhase } {
  const { tier, phase } = classify(input);
  return { tier, phase };
}

/**
 * Final check before a provider attempt, including every tool-loop
 * continuation. Deliberately cheap and stateless: no classification, no quota
 * refresh, no paid authorization decisions — those belong to the routing
 * boundary. The caller supplies CURRENT facts (context, quota, clock) with the
 * committed decision's tier; this refuses an attempt that is already known to
 * be invalid: an unauthenticated route, a context that no longer fits, a
 * missing required capability, a route below the committed quality floor, or
 * a quota window observed as exhausted.
 */
export function admitAttempt(model: RouteModel, input: RouteInput, committedTier?: RouteTier): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(input.contextTokens) || input.contextTokens < 0 ||
      (input.outputMarginTokens !== undefined && (!Number.isFinite(input.outputMarginTokens) || input.outputMarginTokens < 0))) {
    return { ok: false, reason: "a valid complete-context token estimate is required" };
  }
  if (!model.authenticated) return { ok: false, reason: "route is not authenticated" };
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0 ||
      input.contextTokens + (input.outputMarginTokens ?? 16_384) > model.contextWindow) {
    return { ok: false, reason: "complete context and output margin do not fit" };
  }
  if (input.needsImages && !model.supportsImages) return { ok: false, reason: "image input is required" };
  if (input.needsTools !== false && !model.supportsTools) return { ok: false, reason: "tool use is required" };
  if (committedTier && !qualifies(model, committedTier, input)) return { ok: false, reason: "route is below the committed task's quality floor" };
  if (committedTier && canonicalModelRef(model).startsWith("opencode-go/")) {
    if (input.needsTools !== false && !model.validated?.tools) return { ok: false, reason: "Go tool-loop validation is missing" };
    if (input.needsImages && !model.validated?.vision) return { ok: false, reason: "Go vision validation is missing" };
  }
  if (quotaState(model, input) === "depleted") return { ok: false, reason: "an applicable quota window is exhausted" };
  return { ok: true };
}

function quotaState(model: RouteModel, input: RouteInput): QuotaState {
  const snapshot = model.quota;
  if (!snapshot) return "unknown";
  const now = input.now ?? 0;
  const windows = snapshot.windows ?? [];
  // An exhausted window stays blocked until its stated reset, even when the snapshot aged out.
  const exhausted = windows.filter(window => window.exhausted === true || (window.exhausted !== false && (window.usedFraction === 1 || window.remainingFraction === 0)));
  if (exhausted.some(window => window.resetsAt === undefined || window.resetsAt > now)) return "depleted";
  // Passing the reset is not evidence of an empty new window: another client may have used it.
  if (windows.some(window => window.resetsAt !== undefined && window.resetsAt <= now && snapshot.observedAt < window.resetsAt)) return "unknown";
  if (!fresh(snapshot.observedAt, now, input.quotaMaxAgeMs ?? 180_000)) return "unknown";
  if (snapshot.state === "depleted") return "depleted";
  if (snapshot.state === "reserve") return "reserve";
  if (snapshot.state === "unknown") return "unknown";
  let unknownWindow = false;
  let reserved = false;
  for (const window of windows) {
    const remaining = finiteFraction(window.remainingFraction) ? window.remainingFraction
      : finiteFraction(window.usedFraction) ? 1 - window.usedFraction : undefined;
    if (remaining === undefined) { unknownWindow = true; continue; }
    const reserve = finiteFraction(window.reserveFraction) ? window.reserveFraction
      : /fable|premium/.test(window.id) ? 0.20 : /7d|week|seman/.test(window.id) ? 0.15 : 0;
    if (remaining <= reserve) reserved = true;
  }
  if (unknownWindow) return "unknown";
  if (reserved) return "reserve";
  return windows.length > 0 || snapshot.state === "healthy" ? "healthy" : snapshot.state ?? "unknown";
}

function qualifies(model: RouteModel, tier: RouteTier, input: RouteInput): boolean {
  const declared = model.qualityTiers ?? QUALIFICATIONS[canonicalModelRef(model)] ?? QUALIFICATIONS[model.ref];
  if (declared) return declared.includes(tier);
  // A previously accepted current route can be retained; unknown models are never newly chosen.
  return model.ref === input.current?.model && input.current.tier !== undefined && rank(input.current.tier) >= rank(tier);
}

function modelEffort(model: RouteModel, tier: RouteTier, input: RouteInput, requested?: Effort): Effort {
  const desired = requested ?? (tier === "mechanical" ? "medium" :
    (input.task?.failedQualityChecks ?? 0) >= 2 && (tier === "complex" || tier === "premium") ? "xhigh" : "high");
  if (!model.supportedEfforts?.length) return desired;
  if (model.supportedEfforts.includes(desired)) return desired;
  const sorted = [...model.supportedEfforts].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  return sorted.filter(level => EFFORTS.indexOf(level) <= EFFORTS.indexOf(desired)).at(-1) ?? sorted[0]!;
}

function rejection(model: RouteModel, tier: RouteTier, input: RouteInput, isManual = false): string | undefined {
  if (!model.authenticated) return "route is not authenticated";
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0 ||
      input.contextTokens + (input.outputMarginTokens ?? 16_384) > model.contextWindow) return "complete context and output margin do not fit";
  if (input.needsImages && !model.supportsImages) return "image input is required";
  if (input.needsTools !== false && !model.supportsTools) return "tool use is required";
  if (!isManual && !qualifies(model, tier, input)) return "model is not qualified for the task's capability floor";
  if (/\/(?:auto|openrouter\/auto)$/.test(model.ref)) return "generic automatic upstream routing is outside this loadout";
  if (!isManual && canonicalModelRef(model).startsWith("opencode-go/")) {
    if (input.needsTools !== false && !model.validated?.tools) return "Go tool-loop validation is missing";
    if (input.needsImages && !model.validated?.vision) return "Go vision validation is missing";
    if (!model.validated?.reasoning) return "Go reasoning mapping validation is missing";
  }
  const paid = model.payg === true || model.ref.startsWith("openrouter/") || model.ref.startsWith("deepseek/");
  if (paid && !isManual && !(input.paidFallback?.authorized && input.paidFallback.budgetReserved && input.paidFallback.allowedModels.includes(model.ref))) {
    return "paid fallback lacks explicit authorization and a reserved budget";
  }
  const quota = quotaState(model, input);
  if (quota === "depleted") return "an applicable quota window is exhausted";
  const establishedPremium = model.ref === input.current?.model && input.current.tier !== undefined && input.boundary !== "child";
  if (!isManual && canonicalModelRef(model) === MODELS.fable && !establishedPremium && quota === "unknown") {
    return "a new premium route requires fresh quota evidence";
  }
  return undefined;
}

function preference(tier: RouteTier, phase: RoutePhase, input: RouteInput): string[] {
  const now = input.now ?? 0;
  const promo = input.promotion?.active === true && fresh(input.promotion.confirmedAt, now, input.promotionMaxAgeMs ?? 3_600_000);
  // A fresh confirmed Go promotion puts DeepSeek ahead of GLM for the worker pool.
  const workers = promo ? [MODELS.deepseek, MODELS.glm] : [MODELS.glm, MODELS.deepseek];
  if (phase === "review") return [MODELS.fable, MODELS.astra];
  if (phase === "implementation" && tier !== "bounded") {
    // Repeated quality failures must move implementation up the quality
    // ladder before considering the legacy Sol/Opus fallbacks.
    return [MODELS.astra, MODELS.fable, MODELS.sol, MODELS.opus, MODELS.sonnet];
  }
  if (phase === "implementation") return [...workers, MODELS.astra, MODELS.fable, MODELS.sol, MODELS.sonnet, MODELS.opus];
  if (phase === "investigation") {
    // High-value work may explicitly spend the premium reserve; ordinary
    // research still prefers Astra even when its inferred tier is premium.
    return tier === "premium" && input.task?.highValue
      ? [MODELS.fable, MODELS.astra, MODELS.opus]
      : [MODELS.astra, MODELS.opus, MODELS.fable];
  }
  switch (tier) {
    case "mechanical": return [MODELS.luna, MODELS.sol, ...workers, MODELS.sonnet, MODELS.astra, MODELS.opus, MODELS.fable];
    case "bounded": return [...workers, MODELS.sol, MODELS.sonnet, MODELS.astra, MODELS.opus, MODELS.fable];
    case "execution": return [MODELS.sol, MODELS.sonnet, MODELS.astra, MODELS.opus, MODELS.fable];
    case "complex": return [MODELS.astra, MODELS.opus, MODELS.fable];
    case "premium": return [MODELS.fable, MODELS.astra, MODELS.opus];
  }
}

/** Continuous quota headroom: remaining fraction per hour until reset. Larger = more slack. -1 when unknown. */
export function pressure(snapshot: QuotaSnapshot | undefined, now: number): number {
  const windows = (snapshot?.windows ?? []).filter(window => finiteFraction(window.remainingFraction));
  if (!windows.length) return -1;
  return Math.min(...windows.map(window => window.remainingFraction! / Math.max(1, ((window.resetsAt ?? now + 3600000) - now) / 3600000)));
}
export const PRESSURE_SWAP_RATIO = 0.5;

/**
 * Fraction of a shared allowance an average task consumes. 9Router reports
 * windows as PERCENTAGES with no absolute capacity, so a token-denominated
 * estimate cannot be converted into window units without inventing the
 * denominator. This is a deliberately coarse per-agent debit: its only job is
 * to stop N concurrent agents all ranking the same slack as available.
 */
export const IN_FLIGHT_WINDOW_DEBIT = 0.05;

/**
 * Remaining fraction of a window after the work already committed against the
 * same allowance. Shared identity matters here: two agents on different models
 * of one subscription draw on one window, which a provider-level sibling count
 * cannot see.
 */
function postRequestFraction(window: QuotaWindow, input: RouteInput): number {
  const remaining = window.remainingFraction!;
  const key = window.sharedKey;
  const inFlight = key ? (input.inFlightByWindow?.[key] ?? 0) : 0;
  return Math.max(0, remaining - inFlight * IN_FLIGHT_WINDOW_DEBIT);
}

/**
 * Headroom after in-flight commitments: remaining fraction per hour until
 * reset, minus what agents already working against the same shared allowance
 * will consume. -1 when unknown.
 */
export function usableHeadroom(snapshot: QuotaSnapshot | undefined, input: RouteInput): number {
  const now = input.now ?? 0;
  const windows = (snapshot?.windows ?? []).filter(window => finiteFraction(window.remainingFraction));
  if (!windows.length) return -1;
  return Math.min(...windows.map(window =>
    postRequestFraction(window, input) / Math.max(1, ((window.resetsAt ?? now + 3600000) - now) / 3600000)));
}

/**
 * Cost class of a model. The allocator NEVER crosses upward: a task the cheapest
 * qualified class can do is never given to a dearer class, however much slack
 * the dearer class has. Within a class, headroom decides. Order is by what a
 * turn costs you: free/flat workers, then mid subscriptions, then premium
 * allowances that are the scarcest thing you own.
 */
const COST_CLASS: Record<string, number> = {
  [MODELS.deepseek]: 0, [MODELS.glm]: 0, [MODELS.luna]: 0,
  [MODELS.sol]: 1, [MODELS.sonnet]: 1,
  [MODELS.astra]: 2, [MODELS.opus]: 2, [MODELS.fable]: 2,
};
/** Paid-as-you-go routes: the scarce resource is cash, not a subscription window. */
export const PAID_COST_CLASS = 3;
const costClass = (model: RouteModel): number => {
  if (model.payg === true || model.ref.startsWith("openrouter/") || model.ref.startsWith("deepseek/")) return PAID_COST_CLASS;
  return COST_CLASS[canonicalModelRef(model)] ?? 2;
};
/**
 * Headroom the allocator ranks by: post-request usable capacity of the scarcest
 * applicable window. Work already in flight against the same shared allowance
 * is debited first, so N concurrent agents cannot all count the same slack.
 * Sibling children holding the same provider dilute it further (a coarser
 * signal that also covers windows with no shared identity). Reserve state
 * halves it so a reserve window is used only when nothing else in the class
 * has slack. Unknown quota ranks below any known value: it is not evidence of
 * capacity.
 */
function allocationHeadroom(model: RouteModel, input: RouteInput): number {
  // Only fresh, unexpired, non-reset observations supply positive headroom:
  // quotaState applies the freshness and reset checks that pressure() lacks.
  const state = quotaState(model, input);
  if (state === "unknown" || state === "depleted") return -1;
  let value = usableHeadroom(model.quota, input);
  if (value < 0) return -1;
  if (input.boundary === "child") {
    const load = (input.siblings ?? [])
      .filter(entry => entry.canonicalRef.split("/")[0] === canonicalModelRef(model).split("/")[0])
      .reduce((sum, entry) => sum + entry.count, 0);
    value = value / (1 + load);
  }
  if (!input.task?.highValue && state === "reserve") value = value / 2;
  return value;
}

export function decideRoute(input: RouteInput): RouteDecision {
  const classification = classify(input);
  if (input.classification && (input.classification.tier !== classification.tier || input.classification.phase !== classification.phase)) {
    // An explicit resolved classification is authoritative for this request;
    // it is not a continuation signal, so the current route is not preserved
    // merely because the prompt looked uncertain.
    classification.tier = input.classification.tier;
    classification.phase = input.classification.phase;
    classification.uncertain = false;
    classification.continuation = false;
    classification.phaseLocked = undefined;
  }
  const failures = input.task?.failedQualityChecks ?? 0;
  if (failures >= 2) {
    const previousTier = input.previous?.tier ?? input.current?.tier ?? classification.tier;
    classification.tier = TIERS[Math.min(TIERS.length - 1, Math.max(rank(classification.tier), rank(previousTier) + 1))]!;
  }
  const { tier, phase } = classification;
  const rejected: RouteDecision["rejected"] = [];
  const unavailable = (reason: string): RouteDecision => ({ action: "unavailable", tier, phase, reason, rejected });
  if (!Number.isFinite(input.contextTokens) || input.contextTokens < 0 ||
      (input.outputMarginTokens !== undefined && (!Number.isFinite(input.outputMarginTokens) || input.outputMarginTokens < 0))) {
    return unavailable("A valid complete-context token estimate is required; history will not be truncated.");
  }
  const current = input.models.find(model => model.ref === input.current?.model);
  const decisionFor = (model: RouteModel, reason: string, effort?: Effort): RouteDecision => ({
    action: model.ref === input.current?.model ? "preserve" : "select",
    model: model.ref, effort: modelEffort(model, tier, input, effort), tier, phase, reason,
    quotaState: quotaState(model, input), rejected,
  });

  if (input.manualPin) {
    const pinned = input.models.find(model => model.ref === input.manualPin!.model);
    if (!pinned) return unavailable("The explicitly pinned model is absent; automatic substitution is disabled.");
    const why = rejection(pinned, tier, input, true);
    if (why) { rejected.push({ model: pinned.ref, reason: why }); return unavailable("The explicit pin is unavailable: " + why + "."); }
    return decisionFor(pinned, "Explicit user model pin takes precedence over automatic routing.", input.manualPin.effort ?? input.current?.effort);
  }

  if (input.boundary === "tool") {
    if (!current) return unavailable("No established route exists for this tool-loop continuation.");
    const why = rejection(current, input.current?.tier ?? tier, input);
    if (why) { rejected.push({ model: current.ref, reason: why }); return unavailable("The established route cannot continue; native failure handling must reconcile it."); }
    return {
      ...decisionFor(current, "Keep the established route during the tool loop; no economic switch is allowed.", input.current?.effort),
      tier: input.current?.tier ?? tier,
      phase: input.current?.phase ?? phase,
    };
  }

  const eligible = input.models.filter(model => {
    const why = rejection(model, tier, input);
    if (why) rejected.push({ model: model.ref, reason: why });
    return !why;
  });
  if (eligible.length === 0) return unavailable("No authenticated route meets capability, context, quota and payment constraints; the quality floor is unchanged.");

  if (current && eligible.includes(current) && failures < 2 && input.boundary !== "provider-failure" &&
      (classification.continuation || classification.uncertain)) {
    return decisionFor(current, classification.phaseLocked
      ? "Preserve the planning phase until an explicit phase boundary or work-state handoff."
      : classification.continuation ? "Continue the established phase and capable model; a short follow-up is not a downgrade signal."
      : "Classification is uncertain; retain the currently qualified model.", input.current?.effort);
  }

  const order = preference(tier, phase, input);
  // A mapped gateway route owns its canonical identity for automatic routing.
  // Keep the direct route available to explicit pins, but do not silently fall
  // back to it when the gateway route is unavailable or fails in transport.
  const gatewayCanonicalRefs = new Set(input.models
    .filter(model => isGatewayModel(model) && model.canonicalRef)
    .map(model => model.canonicalRef!));
  const automaticEligible = eligible.filter(model => {
    if (phase === "review" && canonicalModelRef(model) !== MODELS.fable && canonicalModelRef(model) !== MODELS.astra) {
      rejected.push({ model: model.ref, reason: "review routing is limited to Fable or Astra" });
      return false;
    }
    if (isGatewayModel(model) || !gatewayCanonicalRefs.has(canonicalModelRef(model))) return true;
    rejected.push({ model: model.ref, reason: "a mapped 9Router route owns this canonical identity; direct fallback requires an explicit pin" });
    return false;
  });
  // Allocation. Fix the cheapest eligible cost class (never cross upward),
  // then shortlist the candidates whose known headroom is within
  // PRESSURE_SWAP_RATIO of the class maximum, then order the shortlist by the
  // reviewed preference list, gateway-first, then ref. Global thresholds keep
  // the ordering total: a pairwise ratio comparator was cyclic.
  const headroomOf = new Map<RouteModel, number>(automaticEligible.map(model => [model, allocationHeadroom(model, input)]));
  const cheapest = Math.min(...automaticEligible.map(costClass));
  const inClass = automaticEligible.filter(model => costClass(model) === cheapest);
  const known = inClass.filter(model => headroomOf.get(model)! >= 0);
  const maxHeadroom = known.length ? Math.max(...known.map(model => headroomOf.get(model)!)) : -1;
  const shortlist = known.length ? known.filter(model => headroomOf.get(model)! >= PRESSURE_SWAP_RATIO * maxHeadroom) : inClass;
  // Inside the paid class the scarce resource is cash, not a quota window, so
  // a known cheaper forecast wins before the reviewed preference order. A
  // route with no price never outranks one with a known price.
  const byCost = (a: RouteModel, b: RouteModel) => {
    if (cheapest !== PAID_COST_CLASS) return 0;
    const ca = a.taskCostUsd, cb = b.taskCostUsd;
    if (ca === cb) return 0;
    if (ca === undefined) return 1;
    if (cb === undefined) return -1;
    return ca - cb;
  };
  const byPreference = (a: RouteModel, b: RouteModel) => {
    const aIndex = order.indexOf(canonicalModelRef(a)), bIndex = order.indexOf(canonicalModelRef(b));
    return byCost(a, b)
      || ((aIndex < 0 ? order.length : aIndex) - (bIndex < 0 ? order.length : bIndex))
      || (Number(isGatewayModel(b)) - Number(isGatewayModel(a)))
      || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  };
  const rest = automaticEligible.filter(model => !shortlist.includes(model))
    .sort((a, b) => (costClass(a) - costClass(b)) || (headroomOf.get(b)! - headroomOf.get(a)!) || byPreference(a, b));
  const candidates = [...[...shortlist].sort(byPreference), ...rest];
  if (candidates.length === 0) return unavailable("No authenticated route meets capability, context, quota and payment constraints; the quality floor is unchanged.");
  const runnerUp = candidates[1];
  const selectedCost = candidates[0]!.taskCostUsd;
  const swapReason = runnerUp && costClass(runnerUp) === costClass(candidates[0]!) && cheapest === PAID_COST_CLASS && selectedCost !== undefined
    ? ` Forecast: ${canonicalModelRef(candidates[0]!)} at $${selectedCost.toFixed(4)}${runnerUp.taskCostUsd !== undefined ? ` under ${canonicalModelRef(runnerUp)} at $${runnerUp.taskCostUsd.toFixed(4)}` : ""}.`
    : runnerUp && costClass(runnerUp) === costClass(candidates[0]!) && order.indexOf(canonicalModelRef(runnerUp)) < order.indexOf(canonicalModelRef(candidates[0]!))
    ? ` Headroom: ${canonicalModelRef(candidates[0]!)} (${headroomOf.get(candidates[0]!)!.toFixed(3)}/h) over ${canonicalModelRef(runnerUp)} (${headroomOf.get(runnerUp)!.toFixed(3)}/h).`
    : "";
  const selected = candidates[0]!;
  if (current && canonicalModelRef(current) === MODELS.fable && selected.ref !== current.ref && input.contextTokens > 0 && input.hasWorkContext !== false && !input.handoffReady) {
    if (eligible.includes(current)) return decisionFor(current, "Retain Fable until a visible work-state handoff makes a model transition safe.", input.current?.effort);
    return unavailable("Leaving unavailable Fable requires a visible work-state handoff before changing models.");
  }
  const reserveNote = quotaState(selected, input) === "reserve" ? " A soft reserve is used because quality takes priority." : "";
  const unknownNote = quotaState(selected, input) === "unknown" ? " Quota is unknown; this is not evidence of unused capacity." : "";
  return decisionFor(selected, `Selected the personal ${tier} loadout after capability and admission checks.${reserveNote}${unknownNote}${swapReason}`);
}
