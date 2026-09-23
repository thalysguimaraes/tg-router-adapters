// Derive downgrade gates from verified outcomes instead of model choice.
//
// The previous version built its "cheap was sufficient" class from the model
// that answered and its "premium was warranted" class from model choice plus
// agreement with the deterministic rules. Both are circular: choosing a model
// is not evidence that the choice was right, and agreeing with the rules we are
// trying to evaluate proves nothing. `scripts/relabel.ts` now writes verified
// outcomes; this consumes them.
//
// Classes:
//   cheapSufficient   a cheap model's work was ACCEPTED. Cheap was enough.
//   premiumWarranted  a cheap model's work QUALITY-FAILED, or the task needed a
//                     dearer model to recover. Cheap was demonstrably not enough.
//
// `infra-failed` and `interrupted` turns are excluded from both: a transport
// failure is not a quality signal and an unfinished task is not a verdict.
//
// Splitting: turns are split by SESSION and by time, never at random. Related
// continuations of one task must not straddle the split, and the holdout must
// be strictly later than the tuning set — otherwise a threshold is tuned on
// turns it will then be "evaluated" against. Gate sweeps report on the tuning
// set; the holdout is scored once, at the chosen gate, and never swept.
//
//   bun run calibrate            # 80 turns per class
//   bun run calibrate 200        # bigger sample (costs ~$0.00005/turn)
//
// Writes ~/.omp/agent/personal-router/calibration.json
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildRoutingContext } from '../core/routing-context';
import { JEV_QUESTIONS } from '../core/jev-questions';
import { JEVS_CLASSIFIER_MODEL } from '../core/jev-client';
import { MODELS } from '../core/policy';

const root = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'), 'personal-router');
mkdirSync(root, { recursive: true, mode: 0o700 });
const perClass = Number(process.argv[2] ?? 80);
/** Fraction of the timeline reserved as a frozen holdout. */
const HOLDOUT_FRACTION = 0.3;

const key = process.env.TYPESAFE_API_KEY
  ?? execSync(`op read ${JSON.stringify(process.env.OMP_ROUTER_TYPESAFE_OP_REF ?? 'op://Personal/AgentKit - Typesafe/password')}`).toString().trim();

interface Row {
  session: string;
  at: string;
  prompt: string;
  promptLen: number;
  modelAnswered: string;
  modelsUsed?: string[];
  continuation: boolean;
  child: boolean;
  outcome?: string;
}
const rows: Row[] = readFileSync(join(root, 'session-corpus.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
if (!rows.some(r => r.outcome)) {
  console.error('corpus has no `outcome` labels; run `bun run relabel` first');
  process.exit(1);
}

const CHEAP = new Set<string>([
  MODELS.deepseek, MODELS.glm, MODELS.luna,
  'openrouter/z-ai/glm-5.3-flash', 'deepseek/deepseek-v4-flash', 'opencode-go/deepseek-v4.1-flash',
]);
const DEAR = new Set<string>([MODELS.astra, MODELS.opus, MODELS.fable, 'anthropic/claude-fable-5']);

// Only turns with enough text to be a task at all, never continuations, and
// only turns whose outcome is a verdict about the generated work.
const usable = rows.filter(r =>
  !r.continuation && !r.child && r.promptLen >= 40 &&
  (r.outcome === 'accepted' || r.outcome === 'quality-failed'));

const cheapAnswered = (r: Row) => CHEAP.has(r.modelAnswered);
/** A cheap attempt that a dearer model had to finish: the recovery is the evidence. */
const escalated = (r: Row) =>
  (r.modelsUsed ?? []).some(m => CHEAP.has(m)) && (r.modelsUsed ?? []).some(m => DEAR.has(m));

const cheapSufficientAll = usable.filter(r => r.outcome === 'accepted' && cheapAnswered(r) && !escalated(r));
const premiumWarrantedAll = usable.filter(r =>
  (r.outcome === 'quality-failed' && cheapAnswered(r)) || escalated(r));

// Time-and-session split. Sessions are ordered by their earliest turn, so every
// turn of a session lands on one side of the boundary.
const sessionStart = new Map<string, number>();
for (const r of usable) {
  const at = Date.parse(r.at);
  if (!Number.isFinite(at)) continue;
  const previous = sessionStart.get(r.session);
  if (previous === undefined || at < previous) sessionStart.set(r.session, at);
}
const ordered = [...sessionStart.entries()].sort((a, b) => a[1] - b[1]).map(([session]) => session);
const boundary = Math.max(1, Math.floor(ordered.length * (1 - HOLDOUT_FRACTION)));
const tuningSessions = new Set(ordered.slice(0, boundary));
const inTuning = (r: Row) => tuningSessions.has(r.session);

const sample = <T,>(list: T[], n: number): T[] => {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j]!, copy[i]!]; }
  return copy.slice(0, n);
};

const holdoutSize = Math.max(1, Math.round(perClass * HOLDOUT_FRACTION));
const split = {
  tuneCheap: sample(cheapSufficientAll.filter(inTuning), perClass),
  tunePremium: sample(premiumWarrantedAll.filter(inTuning), perClass),
  holdCheap: sample(cheapSufficientAll.filter(r => !inTuning(r)), holdoutSize),
  holdPremium: sample(premiumWarrantedAll.filter(r => !inTuning(r)), holdoutSize),
};

console.log(`corpus: ${cheapSufficientAll.length} cheap-sufficient, ${premiumWarrantedAll.length} premium-warranted (of ${usable.length} verdict turns)`);
console.log(`sessions: ${tuningSessions.size} tuning, ${ordered.length - tuningSessions.size} holdout (split at ${new Date(sessionStart.get(ordered[boundary] ?? ordered.at(-1)!) ?? 0).toISOString()})`);
console.log(`scoring ${split.tuneCheap.length + split.tunePremium.length} tuning and ${split.holdCheap.length + split.holdPremium.length} holdout turns`);

interface Scored {
  label: 'cheap' | 'premium';
  split: 'tune' | 'hold';
  tier: string;
  confidence: number;
  topP: number;
  higherMass: number;
  highImpact: number;
  underspecified: number;
  prompt: string;
}

async function score(row: Row, label: Scored['label'], part: Scored['split']): Promise<Scored | undefined> {
  const state = buildRoutingContext({
    taskGoal: row.prompt, currentUserRequest: row.prompt,
    boundary: 'user', hasImages: false, toolsRequired: true, confirmedQualityFailures: 0,
  });
  try {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      // The pinned version the router actually uses; a gate tuned against the
      // alias would be a gate for whatever the alias resolved to that day.
      body: JSON.stringify({ model: JEVS_CLASSIFIER_MODEL, state, questions: JEV_QUESTIONS }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return undefined;
    const body = await res.json() as { answers?: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }> };
    const cap = body.answers?.capability;
    if (!cap?.choice || !cap.probabilities) return undefined;
    const ORDER = ['mechanical', 'bounded', 'execution', 'complex', 'premium'];
    const rank = ORDER.indexOf(cap.choice);
    const higherMass = rank < 0 ? 1 : ORDER.slice(rank + 1).reduce((sum, t) => sum + (cap.probabilities![t] ?? 0), 0);
    return {
      label, split: part, tier: cap.choice, confidence: cap.confidence ?? 0,
      topP: cap.probabilities[cap.choice] ?? 0, higherMass,
      highImpact: body.answers?.highImpact?.noul ?? 0,
      underspecified: body.answers?.underspecified?.noul ?? 0,
      prompt: row.prompt.slice(0, 80).replace(/\s+/g, ' '),
    };
  } catch { return undefined; }
}

// Bounded concurrency: Jev's rate limit is generous but be polite.
const scored: Scored[] = [];
const queue: Array<[Row, Scored['label'], Scored['split']]> = [
  ...split.tuneCheap.map(r => [r, 'cheap', 'tune'] as [Row, Scored['label'], Scored['split']]),
  ...split.tunePremium.map(r => [r, 'premium', 'tune'] as [Row, Scored['label'], Scored['split']]),
  ...split.holdCheap.map(r => [r, 'cheap', 'hold'] as [Row, Scored['label'], Scored['split']]),
  ...split.holdPremium.map(r => [r, 'premium', 'hold'] as [Row, Scored['label'], Scored['split']]),
];
const workers = Array.from({ length: 6 }, async () => {
  for (;;) {
    const next = queue.shift();
    if (!next) return;
    const result = await score(next[0], next[1], next[2]);
    if (result) scored.push(result);
  }
});
await Promise.all(workers);

const pct = (n: number, d: number) => d ? `${((100 * n) / d).toFixed(0)}%` : 'n/a';
const CHEAP_TIERS = new Set(['mechanical', 'bounded']);
const group = (label: Scored['label'], part: Scored['split']) => scored.filter(s => s.label === label && s.split === part);
const tuneCheap = group('cheap', 'tune'), tunePremium = group('premium', 'tune');
const holdCheap = group('cheap', 'hold'), holdPremium = group('premium', 'hold');

console.log(`\nscored ${scored.length} turns (tune ${tuneCheap.length}/${tunePremium.length}, hold ${holdCheap.length}/${holdPremium.length})`);
if (tuneCheap.length < 20 || tunePremium.length < 20) {
  console.log('WARNING: fewer than 20 turns in a tuning class. Any separation below is noise.');
}
console.log('\n=== Does Jev put accepted cheap work in a cheap tier? (tuning set)');
console.log(`  cheap-sufficient judged mechanical/bounded: ${pct(tuneCheap.filter(s => CHEAP_TIERS.has(s.tier)).length, tuneCheap.length)}`);
console.log(`  premium-warranted judged mechanical/bounded: ${pct(tunePremium.filter(s => CHEAP_TIERS.has(s.tier)).length, tunePremium.length)}  <- must stay low`);

// A gate is only useful if it admits cheap work while excluding premium work.
const gateOf = (mass: number, conf: number) => (s: Scored) =>
  CHEAP_TIERS.has(s.tier) && s.higherMass <= mass && s.confidence >= conf && s.highImpact < 0.5 && s.underspecified < 0.5;

console.log('\n=== Gate sweep on the TUNING set only');
console.log('  higherMass  conf   admits cheap   admits premium (false downgrades)');
let best: { mass: number; conf: number; cheap: number } | undefined;
for (const mass of [0.01, 0.05, 0.10, 0.20, 0.35, 1.0]) {
  for (const conf of [0.5, 0.6, 0.7, 0.8]) {
    const passes = gateOf(mass, conf);
    const c = tuneCheap.filter(passes).length, p = tunePremium.filter(passes).length;
    if (c === 0 && p === 0) continue;
    console.log(`  ${String(mass).padEnd(11)} ${String(conf).padEnd(6)} ${String(c).padStart(3)}/${tuneCheap.length} (${pct(c, tuneCheap.length).padStart(4)})   ${String(p).padStart(3)}/${tunePremium.length} (${pct(p, tunePremium.length)})`);
    // Candidate = zero false downgrades on the tuning set, most cheap admitted.
    if (p === 0 && (!best || c > best.cheap)) best = { mass, conf, cheap: c };
  }
}

// The holdout is scored ONCE, at the gate the sweep chose, and never swept.
let holdout: { mass: number; conf: number; admitsCheap: number; falseDowngrades: number } | undefined;
if (best && holdCheap.length + holdPremium.length > 0) {
  const passes = gateOf(best.mass, best.conf);
  const c = holdCheap.filter(passes).length, p = holdPremium.filter(passes).length;
  holdout = { mass: best.mass, conf: best.conf, admitsCheap: c, falseDowngrades: p };
  console.log(`\n=== Frozen holdout at the chosen gate (mass<=${best.mass}, conf>=${best.conf})`);
  console.log(`  admits cheap:     ${c}/${holdCheap.length} (${pct(c, holdCheap.length)})`);
  console.log(`  false downgrades: ${p}/${holdPremium.length} (${pct(p, holdPremium.length)})  <- must be 0 to ship`);
  if (p > 0) console.log('  VERDICT: do not enable semantic downgrades.');
} else if (!best) {
  console.log('\nNo gate reached zero false downgrades on the tuning set; nothing to evaluate on the holdout.');
}

const falseDowngrades = tunePremium.filter(s => CHEAP_TIERS.has(s.tier));
if (falseDowngrades.length) {
  console.log('\n=== Premium-warranted turns Jev judged cheap (inspect these):');
  for (const s of falseDowngrades.slice(0, 8)) console.log(`  ${s.tier}/${s.confidence.toFixed(2)} mass=${s.higherMass.toFixed(3)} | ${s.prompt}`);
}

const out = join(root, 'calibration.json');
writeFileSync(out, JSON.stringify({
  calibratedAt: new Date().toISOString(),
  classifierModel: JEVS_CLASSIFIER_MODEL,
  perClass,
  holdoutFraction: HOLDOUT_FRACTION,
  corpus: { cheapSufficient: cheapSufficientAll.length, premiumWarranted: premiumWarrantedAll.length, verdictTurns: usable.length },
  chosenGate: best,
  holdout,
  scored,
}, null, 2) + '\n', { mode: 0o600 });
console.log(`\nraw scores: ${out}`);
