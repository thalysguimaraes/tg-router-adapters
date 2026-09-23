import { describe, expect, test } from "bun:test";
import { MODELS, PRESSURE_SWAP_RATIO, pressure, decideRoute, admitAttempt, childFloorFor, type QuotaSnapshot, type RouteInput, type RouteModel } from "./policy";
import { gatewayQuota } from "./ninerouter-usage";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const HOUR = 3_600_000;

const snapshot = (remainingFraction: number, hoursToReset: number): QuotaSnapshot => ({
  observedAt: NOW - 1_000,
  state: "healthy",
  windows: [{ id: "session", remainingFraction, resetsAt: NOW + hoursToReset * HOUR }],
});

const model = (name: "astra" | "fable", quota: QuotaSnapshot): RouteModel => ({
  ref: name === "astra" ? "9router/cx/gpt-6-astra" : "9router/cc/claude-fable-5-1",
  canonicalRef: MODELS[name],
  gateway: true,
  authenticated: true,
  contextWindow: 400_000,
  supportsTools: true,
  supportsImages: false,
  quota,
});

const input = (quota: QuotaSnapshot, overrides: Partial<RouteInput> = {}): RouteInput => ({
  prompt: "plan the migration",
  now: NOW,
  contextTokens: 50_000,
  boundary: "user",
  models: [model("astra", quota), model("fable", snapshot(0.92, 132))],
  ...overrides,
});

test("pressure is remaining fraction normalized by hours to reset", () => {
  expect(pressure(snapshot(0.19, 67), NOW)).toBeCloseTo(0.19 / 67, 10);
  expect(pressure(undefined, NOW)).toBe(-1);
  expect(pressure({ observedAt: NOW, windows: [{ id: "x" }] }, NOW)).toBe(-1);
  expect(PRESSURE_SWAP_RATIO).toBe(0.5);
});

describe("model lock lifetime", () => {
  // One account, STALE positive usage, unexpired Astra lock. The adapter,
  // allocator and admission gate must all block while the lock is active and
  // must all reopen as unknown (not full) once it expires.
  const lockUntil = NOW + 2 * HOUR;
  const cache: any = {
    version: 1, fetchedAt: NOW - 30 * 60_000, total: {},
    providers: { codex: { accounts: [{ idHash: "h", connectionId: "cx-1", priority: 1, modelLocks: { "gpt-6-astra": new Date(lockUntil).toISOString() },
      windows: [{ id: "session", used: 10, total: 100, remaining: 90, remainingPercentage: 90, resetAt: NOW + 67 * HOUR }] }] } },
  };
  test("active lock blocks end to end despite stale positive usage", () => {
    const quota = gatewayQuota("openai-codex/gpt-6-astra", cache, NOW);
    expect(quota.state).toBe("depleted");
    expect(quota.windows?.find(w => w.id === "model-lock")?.resetsAt).toBe(lockUntil);
    const decision = decideRoute(input(quota));
    expect(decision.model).toBe("9router/cc/claude-fable-5-1");
    expect(decision.rejected.find(r => r.model === "9router/cx/gpt-6-astra")?.reason).toContain("exhausted");
    expect(admitAttempt(model("astra", quota), input(quota))).toEqual({ ok: false, reason: "an applicable quota window is exhausted" });
  });
  test("expired lock reopens as unknown, not as full capacity", () => {
    const later = lockUntil + 1;
    const quota = gatewayQuota("openai-codex/gpt-6-astra", cache, later);
    expect(quota.state).toBe("unknown");
    expect(quota.windows?.find(w => w.id === "model-lock")).toBeUndefined();
    expect(admitAttempt(model("astra", quota), input(quota, { now: later })).ok).toBe(true);
  });
});

describe("admitAttempt with current facts", () => {
  const healthy = snapshot(0.9, 67);
  test("rejects NaN and negative context estimates", () => {
    expect(admitAttempt(model("astra", healthy), input(healthy, { contextTokens: Number.NaN })).ok).toBe(false);
    expect(admitAttempt(model("astra", healthy), input(healthy, { contextTokens: -1 })).ok).toBe(false);
  });
  test("context grown past the window is refused", () => {
    expect(admitAttempt(model("astra", healthy), input(healthy, { contextTokens: 2_000_000 }))).toEqual({ ok: false, reason: "complete context and output margin do not fit" });
  });
  test("a route below the committed tier is refused; a qualified one passes", () => {
    const glm: RouteModel = { ref: "9router/ocg/glm-5.3-flash", canonicalRef: MODELS.glm, gateway: true, authenticated: true, contextWindow: 200_000, supportsTools: true, supportsImages: false, quota: healthy, validated: { tools: true, vision: false, reasoning: true } };
    expect(admitAttempt(glm, input(healthy), "premium")).toEqual({ ok: false, reason: "route is below the committed task's quality floor" });
    expect(admitAttempt(glm, input(healthy), "bounded").ok).toBe(true);
    expect(admitAttempt(model("astra", healthy), input(healthy), "premium").ok).toBe(true);
  });
});

test("within a cost class, the candidate with meaningfully more headroom wins", () => {
  // Astra 0.19/67h vs Fable 0.92/132h: Fable has ~2.5x the headroom per hour.
  const decision = decideRoute(input(snapshot(0.19, 67)));
  expect(decision.model).toBe("9router/cc/claude-fable-5-1");
  expect(decision.reason).toContain("Headroom:");
});

test("highValue lets a reserve window count at full headroom but does not change class order", () => {
  const decision = decideRoute(input(snapshot(0.19, 67), { task: { highValue: true } }));
  // Headroom still decides within the premium class; highValue only stops the reserve halving.
  expect(decision.model).toBe("9router/cc/claude-fable-5-1");
});

test("small headroom differences fall through to the reviewed preference order", () => {
  const decision = decideRoute(input(snapshot(0.60, 67)));
  expect(decision.model).toBe("9router/cx/gpt-6-astra");
  expect(decision.reason).not.toContain("Headroom:");
});

test("sibling children holding a provider dilute its headroom", () => {
  const decision = decideRoute(input(snapshot(0.60, 67), {
    boundary: "child",
    siblings: [{ canonicalRef: MODELS.astra, count: 2 }],
  }));
  expect(decision.model).toBe("9router/cc/claude-fable-5-1");
  expect(decision.reason).toContain("Headroom:");
});

test("the allocator never crosses a cost class upward, whatever the slack", () => {
  // A mechanical task with a drained worker and a wide-open premium model:
  // the worker still wins because premium is never spent on cheap-class work.
  const drainedWorker: RouteModel = {
    ref: "9router/ocg/deepseek-v4.1-flash", canonicalRef: MODELS.deepseek, gateway: true, authenticated: true,
    contextWindow: 200_000, supportsTools: true, supportsImages: false, validated: { tools: true, reasoning: true },
    quota: { observedAt: NOW - 1_000, state: "reserve", windows: [{ id: "weekly", remainingFraction: 0.12, reserveFraction: 0.15, resetsAt: NOW + 60 * HOUR }] },
  };
  const decision = decideRoute({
    prompt: "rename the variable tmp to buffer", now: NOW, contextTokens: 5_000, boundary: "user",
    models: [drainedWorker, model("fable", snapshot(0.95, 132))],
  });
  expect(decision.tier).toBe("mechanical");
  expect(decision.model).toBe(drainedWorker.ref);
  expect(decision.reason).toContain("soft reserve");
});

test("a subscription route beats a paid route in the same class", () => {
  const paidSol: RouteModel = {
    ref: "openrouter/openai/gpt-5.6-sol", canonicalRef: "openrouter/openai/gpt-5.6-sol", authenticated: true,
    contextWindow: 400_000, supportsTools: true, supportsImages: false, payg: true,
    qualityTiers: ["mechanical", "bounded", "execution"],
    quota: { observedAt: NOW - 1_000, state: "healthy", windows: [{ id: "cash", remainingFraction: 1 }] },
  };
  const subSol: RouteModel = {
    ref: "9router/cx/gpt-5.6-sol", canonicalRef: MODELS.sol, gateway: true, authenticated: true,
    contextWindow: 400_000, supportsTools: true, supportsImages: false,
    quota: { observedAt: NOW - 1_000, state: "healthy", windows: [{ id: "weekly", remainingFraction: 0.3, resetsAt: NOW + 100 * HOUR }] },
  };
  const decision = decideRoute({
    prompt: "review this diff", now: NOW, contextTokens: 5_000, boundary: "user",
    models: [paidSol, subSol, model("astra", snapshot(0.5, 100))],
    paidFallback: { authorized: true, budgetReserved: true, allowedModels: [paidSol.ref] },
  });
  expect(decision.model).not.toBe(paidSol.ref);
});

// A child inherits a floor from the parent's subagent role. Roles are no
// longer a user command: the floor raises vague or under-classified prompts
// and never lowers an explicit one.
const workerModel: RouteModel = {
  ref: "9router/ocg/glm-5.3-flash", canonicalRef: MODELS.glm, gateway: true, authenticated: true,
  contextWindow: 200_000, supportsTools: true, supportsImages: false, validated: { tools: true, reasoning: true },
  quota: { observedAt: NOW - 1_000, state: "healthy", windows: [{ id: "daily", remainingFraction: 0.9 }] },
};
const childInput = (prompt: string, floor: RouteInput["childFloor"]): RouteInput => ({
  prompt, now: NOW, contextTokens: 5_000, boundary: "child", childFloor: floor,
  models: [model("astra", snapshot(0.8, 100)), workerModel],
});

test("a vague prompt takes the child floor's tier and phase", () => {
  expect(childFloorFor("plan")).toEqual({ tier: "complex", phase: "planning" });
  const planner = decideRoute(childInput("here is what we have so far", childFloorFor("plan")));
  expect(planner.tier).toBe("complex");
  expect(planner.phase).toBe("planning");
  const worker = decideRoute(childInput("here is what we have so far", childFloorFor("task")));
  expect(worker.tier).toBe("bounded");
  expect(worker.phase).toBe("implementation");
  expect(worker.model).toBe(workerModel.ref);
});

test("the child floor raises an under-classified prompt but never lowers an explicit one", () => {
  const raised = decideRoute(childInput("rename the variable", childFloorFor("pesquisa")));
  expect(raised.tier).toBe("complex");
  const kept = decideRoute(childInput("plan the migration architecture", childFloorFor("task")));
  expect(kept.tier).toBe("complex");
  expect(kept.phase).toBe("planning");
});

test("unknown subagent roles yield no floor", () => {
  expect(childFloorFor("default")).toBeUndefined();
  expect(childFloorFor(undefined)).toBeUndefined();
});

// Evidence-based classification rules derived from the outcome-labelled
// session corpus (scripts/relabel.ts). Replay invariant on the corpus:
// 0/144 turns where a cheap model struggled are pushed down by these rules.
const classifyOnly = (prompt: string) => decideRoute({
  prompt, now: NOW, contextTokens: 5_000, boundary: "user",
  models: [model("astra", snapshot(0.8, 100)), workerModel],
});

test("session and repository operations are bounded worker tasks, not complex", () => {
  for (const prompt of [
    "nice. now deploy it to vercel",
    "good to go. reconcile git and close the worktree",
    "faça o merge (PRs aprovados)",
    "ok, you can commit this part",
    "is git reconciled? we're closing the session",
  ]) {
    const d = classifyOnly(prompt);
    expect(d.tier).toBe("bounded");
    expect(d.model).toBe(workerModel.ref);
  }
});

test("a delegation brief that merely mentions a worktree is not a session op", () => {
  // These carried 53 tool calls and errored on a cheap model in the corpus.
  const d = classifyOnly("Você é a lane E do projeto Exemplo v1.1 (LANE=E). Leia, nesta ordem, /tmp/exemplo-v11/COMMON.md e siga-os integralmente. Trabalhe só nesta worktree/branch.");
  expect(d.tier).not.toBe("bounded");
});

test("a pasted stack trace with no other signal routes to complex investigation", () => {
  // 14% of cheap-struggled turns carried pasted code vs 1% of cheap-clean.
  const d = classifyOnly("## Error Message\n    at Button (components/ui/button.tsx:48:5)\n    at BotSettings (components/bot-settings.tsx:166:11)\n> 48 |     <ButtonPrimitive");
  expect(d.tier).toBe("complex");
  expect(d.phase).toBe("investigation");
});

test("a risky session op still keeps its risk floor", () => {
  // `deploy` is a session op, but `production` is a risk keyword and wins.
  const d = classifyOnly("deploy this to production now");
  expect(d.tier).toBe("complex");
});

test("a delegation brief floors at execution whatever its vocabulary says", () => {
  // Measured over 381 turns where a cheap model was actually tried: briefs
  // finished cleanly 31% of the time vs 69% for everything else, with p50 69
  // tool calls vs 14. The word "list" inside a 200-line spec is not a listing
  // task — this is the anomaly that made `mechanical` keywords look unsafe.
  const brief = [
    "# Goal",
    "Implement the vault-task command and list every affected record.",
    "# Ownership",
    "You own src/vault/*.ts in this worktree only.",
    "# Acceptance",
    "Tests green, no writes outside the checkout.",
    ...Array.from({ length: 20 }, (_, i) => `Step ${i}: perform the described transformation carefully.`),
  ].join("\n");
  const d = classifyOnly(brief);
  expect(d.tier).toBe("execution");
  expect(d.phase).toBe("implementation");
});

test("a genuine mechanical request is still mechanical", () => {
  const d = classifyOnly("rename the variable tmp to buffer and list the files you touched");
  expect(d.tier).toBe("mechanical");
});

test("a brief is not treated as a small session op", () => {
  const brief = [
    "# Goal",
    "Reconcile git and deploy the service once the slice lands.",
    "# Acceptance",
    "Clean worktree, tagged release.",
    ...Array.from({ length: 20 }, (_, i) => `Detail ${i}: follow the runbook precisely and record the outcome.`),
  ].join("\n");
  const d = classifyOnly(brief);
  expect(d.tier).not.toBe("bounded");
  expect(d.tier).not.toBe("mechanical");
});
