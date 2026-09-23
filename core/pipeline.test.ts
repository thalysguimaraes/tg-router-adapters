import { describe, expect, test } from "bun:test";
import { BudgetLedger } from "./budget";
import { createJevClient } from "./jev-client";
import { IN_FLIGHT_WINDOW_DEBIT, MODELS, admitAttempt, classifyTask, decideRoute, resolveClassification, usableHeadroom, type QuotaSnapshot, type RouteInput, type RouteModel } from "./policy";
import { advanceEpisode, advanceDecisionEpoch, isSubstantive } from "./episode";
import { buildRoutingContext, redactText } from "./routing-context";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const HOUR = 3_600_000;
const snapshot = (remainingFraction: number, hoursToReset: number, observedAt = NOW - 1_000): QuotaSnapshot => ({
  observedAt, state: "healthy", windows: [{ id: "session", remainingFraction, resetsAt: NOW + hoursToReset * HOUR }],
});
const model = (canonicalRef: string, quota: QuotaSnapshot, extra: Partial<RouteModel> = {}): RouteModel => ({
  ref: `9router/x/${canonicalRef.split("/")[1]}`, canonicalRef, gateway: true, authenticated: true,
  contextWindow: 400_000, supportsTools: true, supportsImages: false, quota, validated: { tools: true, reasoning: true }, ...extra,
});
const worker = model(MODELS.glm, snapshot(0.9, 4));
const astra = model(MODELS.astra, snapshot(0.8, 100));
const fable = model(MODELS.fable, snapshot(0.8, 100));
const base = (prompt: string, overrides: Partial<RouteInput> = {}): RouteInput => ({
  prompt, now: NOW, contextTokens: 5_000, boundary: "user", models: [worker, astra, fable],
  task: { bounded: true, acceptanceDefined: true }, ...overrides,
});
const premium = { usable: true, tier: { selected: "premium", probabilities: { premium: 0.93, complex: 0.07 }, confidence: 0.91 }, phase: { selected: "planning", confidence: 0.9 } } as const;

describe("classification reaches allocation", () => {
  test("a premium assessment on a bounded prompt selects a premium-qualified model", () => {
    const input = base("implement the parser");
    const rules = classifyTask(input);
    expect(rules.tier).toBe("bounded");
    const resolved = resolveClassification({ assessment: premium as never, rulesClassification: rules, mode: "assisted" });
    expect(resolved.source).toBe("semantic-assisted");
    const decision = decideRoute({ ...input, classification: { tier: resolved.tier, phase: resolved.phase } });
    expect(decision.tier).toBe("premium");
    expect(decision.model).not.toBe(worker.ref);
    // Without the explicit classification the same input still routes to the worker.
    expect(decideRoute(input).model).toBe(worker.ref);
  });

  test("an explicit classification is not a continuation: the current cheap route is not preserved", () => {
    const input = base("ok", { current: { model: worker.ref, tier: "bounded", phase: "implementation" }, previous: { tier: "bounded", phase: "implementation" } });
    const decision = decideRoute({ ...input, classification: { tier: "premium", phase: "planning" } });
    expect(decision.model).not.toBe(worker.ref);
  });
});

describe("phase constraints hold in every resolver branch", () => {
  test("a tier raise honors a locked child phase", () => {
    const result = resolveClassification({ assessment: premium as never, rulesClassification: { tier: "execution", phase: "review" }, mode: "assisted", floorTier: "execution", floorLocksPhase: true });
    expect(result.tier).toBe("premium");
    expect(result.phase).toBe("review");
  });
  test("a rules review phase is never relabeled, and low-confidence phases are no-ops", () => {
    const relabel = { usable: true, phase: { selected: "implementation", confidence: 0.95 } };
    expect(resolveClassification({ assessment: relabel as never, rulesClassification: { tier: "execution", phase: "review" }, mode: "assisted" }).phase).toBe("review");
    const weak = { usable: true, phase: { selected: "planning", confidence: 0.4 } };
    const result = resolveClassification({ assessment: weak as never, rulesClassification: { tier: "complex", phase: "investigation" }, mode: "assisted" });
    expect(result.phase).toBe("investigation");
    expect(result.source).toBe("rules");
  });
});

describe("allocation is deterministic", () => {
  test("permuting an identical candidate set does not change the winner", () => {
    const set = [model(MODELS.astra, snapshot(0.20, 100)), model(MODELS.opus, snapshot(0.35, 100)), model(MODELS.fable, snapshot(0.60, 100))];
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const winners = new Set(perms.map(p => decideRoute({ prompt: "investigate why the build is flaky", now: NOW, contextTokens: 5_000, boundary: "user", models: p.map(i => set[i]!) }).model));
    expect(winners.size).toBe(1);
  });
  test("stale positive capacity cannot outrank fresh capacity", () => {
    const stale = model(MODELS.astra, snapshot(0.9, 100, NOW - 10 * 60_000));
    const freshOpus = model(MODELS.opus, snapshot(0.2, 100));
    const decision = decideRoute({ prompt: "investigate why the build is flaky", now: NOW, contextTokens: 5_000, boundary: "user", models: [stale, freshOpus] });
    expect(decision.model).toBe(freshOpus.ref);
  });
});

describe("classifier reservation lifecycle", () => {
  const answers = {
    phase: { type: "choice", choice: "implementation", confidence: 0.8, probabilities: { lightweight: 0.02, implementation: 0.8, review: 0.03, investigation: 0.05, planning: 0.05, unknown: 0.05 } },
    capability: { type: "choice", choice: "execution", confidence: 0.8, probabilities: { mechanical: 0.02, bounded: 0.1, execution: 0.7, complex: 0.1, premium: 0.05, unknown: 0.03 } },
    bounded: { type: "noul", noul: 0.7 }, highImpact: { type: "noul", noul: 0.1 }, underspecified: { type: "noul", noul: 0.2 },
    reasoningDepth: { type: "score", score: 2, confidence: 0.6, probabilities: { "0": 0, "1": 0, "2": 1, "3": 0, "4": 0 } },
    jobFamily: { type: "choice", choice: "implementation", confidence: 0.9, probabilities: { clerical: 0, implementation: 0.9, review: 0, architecture: 0, investigation: 0.1, visual: 0, other: 0 } },
  };
  const state = () => buildRoutingContext({ taskGoal: "g", currentUserRequest: "r", boundary: "user", hasImages: false, toolsRequired: true, confirmedQualityFailures: 0 });
  const harness = (body: unknown) => {
    const ledger = new BudgetLedger(":memory:", { dailyCapUsd: 10, monthlyCapUsd: 30 });
    let id = "";
    const client = createJevClient({
      deadlineMs: 500, apiKey: "k", inputUsdPerMillion: 0.042,
      admit: (usd) => {
        id = `classifier-${Math.random()}`;
        const r = ledger.reserve(id, usd, NOW, { purpose: "classifier" });
        if (!r.ok) return { ok: false, reason: r.reason };
        return { ok: true, dispatched: () => ledger.markDispatched(id, NOW), settle: (a) => ledger.settle(id, a, NOW) };
      },
      fetchImpl: (async () => Response.json(body)) as unknown as typeof fetch,
    });
    return { client, ledger, id: () => id };
  };
  test("a successful response settles from reported usage; no reservation stays open", async () => {
    const { client, ledger } = harness({ model: "jev-1.13.0", answers, usage: { input_tokens: 1000, output_tokens: 5 } });
    const result = await client.assess(state(), "h");
    expect(result.ok).toBe(true);
    const snap = ledger.snapshot(NOW);
    // Settled at reported usage (1000 tokens * 0.042/M, ceil to micro-USD), well under the byte-bound estimate.
    expect(snap.dailyCommittedUsd).toBeLessThan(0.0001);
    expect(snap.pendingCount).toBe(0);
  });
  test("invalid answers with valid usage still settle", async () => {
    const { client, ledger } = harness({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1000, output_tokens: 5 } });
    const result = await client.assess(state(), "h");
    expect(result.ok).toBe(false);
    expect(ledger.snapshot(NOW).pendingCount).toBe(0);
    expect(ledger.snapshot(NOW).dailyCommittedUsd).toBeLessThan(0.0001);
  });
  test("a response without usage keeps the dispatched liability", async () => {
    const { client, ledger } = harness({ model: "jev-1.13.0", answers });
    await client.assess(state(), "h");
    const snap = ledger.snapshot(NOW);
    expect(snap.dailyCommittedUsd).toBeGreaterThan(0.000042);
  });
});

describe("task episodes", () => {
  const id = () => "ep-1";
  test("a short follow-up continues the episode; a new substantive task replaces the goal", () => {
    const first = advanceEpisode(undefined, "fix the parser so nested groups round-trip correctly", NOW, id);
    expect(first.goal).toContain("nested groups");
    expect(isSubstantive("yep")).toBe(false);
    const followUp = advanceEpisode(first, "yep", NOW, id);
    expect(followUp).toBe(first);
    const newTask = advanceEpisode(first, "now migrate the billing webhooks to the new signing scheme", NOW, id);
    expect(newTask.goal).toContain("billing webhooks");
    expect(newTask.decisionEpoch).toBe(first.decisionEpoch + 1);
  });

  test("a phase boundary keeps the goal but invalidates the decision basis", () => {
    const episode = advanceEpisode(undefined, "fix the parser so nested groups round-trip correctly", NOW, id);
    const handed = advanceDecisionEpoch({ ...episode, phase: "planning" })!;
    expect(handed.goal).toBe(episode.goal);
    expect(handed.phase).toBeUndefined();
    expect(handed.decisionEpoch).toBe(episode.decisionEpoch + 1);
  });
});

describe("per-attempt admission", () => {
  const attempt = (overrides: Partial<RouteInput> = {}): RouteInput => ({ prompt: "", now: NOW, contextTokens: 5_000, models: [], needsTools: true, outputMarginTokens: 8_192, ...overrides });
  test("a depleted quota window refuses another attempt on the established route", () => {
    const depleted = model(MODELS.glm, { observedAt: NOW, state: "depleted", windows: [{ id: "session", exhausted: true, resetsAt: NOW + HOUR }] });
    expect(admitAttempt(depleted, attempt()).ok).toBe(false);
  });
  test("a context that no longer fits refuses the attempt", () => {
    expect(admitAttempt(worker, attempt({ contextTokens: 10_000_000 })).ok).toBe(false);
  });
  test("an otherwise valid route is admitted, without reclassifying", () => {
    expect(admitAttempt(worker, attempt()).ok).toBe(true);
  });
});

describe("redaction covers structured credentials", () => {
  test("quoted JSON keys and opaque prefixed keys are redacted", () => {
    const canary = "CANARY9f8e7d6c5b4a3210zz";
    const out = redactText(`{"token": "${canary}", "api_key": "${canary}", "TS_API_KEY": "${canary}"} apikey_${canary}${canary}`);
    expect(out).not.toContain(canary);
  });
});

describe("forecast vs realized spend is visible", () => {
  test("settled requests report how conservative the reservation bound was", () => {
    const ledger = new BudgetLedger(":memory:", { dailyCapUsd: 10, monthlyCapUsd: 30 });
    expect(ledger.snapshot(NOW).forecast).toBeUndefined();
    for (const [id, estimate, actual] of [["a", 2.0, 0.2], ["b", 1.0, 0.1]] as const) {
      ledger.reserve(id, estimate, NOW);
      ledger.markDispatched(id, NOW);
      ledger.settle(id, actual, NOW);
    }
    const forecast = ledger.snapshot(NOW).forecast!;
    expect(forecast.settledCount).toBe(2);
    expect(forecast.forecastUsd).toBeCloseTo(3, 6);
    expect(forecast.realizedUsd).toBeCloseTo(0.3, 6);
    // A bound reserving 10x the realized spend blocks affordable work through
    // the caps; the drift is the evidence for changing it.
    expect(forecast.ratio).toBeCloseTo(0.1, 6);
    ledger.close();
  });
});


describe("shared windows and in-flight capacity", () => {
  const shared = (remaining: number): QuotaSnapshot => ({
    observedAt: NOW, state: "healthy",
    windows: [{ id: "weekly-7d", sharedKey: "claude:acct-a:weekly-7d", remainingFraction: remaining, resetsAt: NOW + 100 * HOUR }],
  });
  const input = (inFlight: Record<string, number> = {}): RouteInput =>
    ({ prompt: "", now: NOW, contextTokens: 5_000, models: [], inFlightByWindow: inFlight });

  test("work already in flight against the same allowance reduces usable headroom", () => {
    const idle = usableHeadroom(shared(0.5), input());
    const busy = usableHeadroom(shared(0.5), input({ "claude:acct-a:weekly-7d": 3 }));
    expect(busy).toBeLessThan(idle);
    expect(busy).toBeCloseTo((0.5 - 3 * IN_FLIGHT_WINDOW_DEBIT) / 100, 6);
  });

  test("in-flight work on a different allowance does not reduce it", () => {
    expect(usableHeadroom(shared(0.5), input({ "claude:acct-b:weekly-7d": 5 })))
      .toBeCloseTo(usableHeadroom(shared(0.5), input()), 10);
  });

  test("two models sharing one window compete; the busier allowance loses", () => {
    // Fable and Sonnet on one subscription draw on the same weekly meter, which
    // a provider-level sibling count cannot see.
    const busyKey = "claude:acct-a:weekly-7d", freeKey = "claude:acct-b:weekly-7d";
    const withKey = (canonicalRef: string, key: string): RouteModel => ({
      ...model(canonicalRef, shared(0.5)),
      quota: { observedAt: NOW, state: "healthy", windows: [{ id: "weekly-7d", sharedKey: key, remainingFraction: 0.5, resetsAt: NOW + 100 * HOUR }] },
    });
    const decision = decideRoute({
      prompt: "investigate why the build is flaky", now: NOW, contextTokens: 5_000, boundary: "user",
      models: [withKey(MODELS.astra, busyKey), withKey(MODELS.opus, freeKey)],
      inFlightByWindow: { [busyKey]: 8 },
    });
    expect(decision.model).toBe(withKey(MODELS.opus, freeKey).ref);
  });

  test("an in-flight count cannot drive headroom negative and hide a real window", () => {
    expect(usableHeadroom(shared(0.05), input({ "claude:acct-a:weekly-7d": 100 }))).toBe(0);
  });
});

describe("paid candidates are ranked by forecast cost", () => {
  const paid = (id: string, taskCostUsd?: number): RouteModel => ({
    ref: `openrouter/${id}`, canonicalRef: `openrouter/${id}`, authenticated: true, contextWindow: 400_000,
    supportsTools: true, supportsImages: false, payg: true, qualityTiers: ["mechanical", "bounded", "execution", "complex", "premium"],
    ...(taskCostUsd !== undefined ? { taskCostUsd } : {}),
  });
  const decide = (models: RouteModel[]) => decideRoute({
    prompt: "investigate why the build is flaky", now: NOW, contextTokens: 5_000, boundary: "user", models,
    paidFallback: { authorized: true, budgetReserved: true, allowedModels: models.map(m => m.ref) },
  });

  test("the cheaper forecast wins inside the paid class and is named in the reason", () => {
    const decision = decide([paid("dear", 4.20), paid("cheap", 0.42)]);
    expect(decision.model).toBe("openrouter/cheap");
    expect(decision.reason).toContain("Forecast:");
    expect(decision.reason).toContain("$0.4200");
  });

  test("reordering identical paid candidates does not change the winner", () => {
    expect(decide([paid("cheap", 0.42), paid("dear", 4.20)]).model).toBe("openrouter/cheap");
  });

  test("an unpriced paid route never outranks a priced one", () => {
    expect(decide([paid("unknown"), paid("priced", 4.20)]).model).toBe("openrouter/priced");
  });

  test("a subscription route still beats a cheap paid one: classes never cross", () => {
    const decision = decideRoute({
      prompt: "investigate why the build is flaky", now: NOW, contextTokens: 5_000, boundary: "user",
      models: [astra, paid("cheap", 0.0001)],
      paidFallback: { authorized: true, budgetReserved: true, allowedModels: ["openrouter/cheap"] },
    });
    expect(decision.model).toBe(astra.ref);
  });
});