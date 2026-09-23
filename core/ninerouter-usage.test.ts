import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NineRouterAccountUsage, NineRouterQuotaWindow, NineRouterProviderUsage, NineRouterUsageCache } from './ninerouter-usage';
import { gatewayQuota, refreshNineRouterUsage, nineRouterOrigin } from './ninerouter-usage';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function window(id: string, remaining: number, resetInMs: number, filterPartial = false): NineRouterQuotaWindow {
  const value: NineRouterQuotaWindow = {
    id,
    used: 100 - remaining,
    total: 100,
    remaining,
    remainingPercentage: remaining,
    resetAt: NOW + resetInMs,
  };
  if (filterPartial) {
    // Partial field filter asserts sanitizeWindow keeps evidence when only used/total exist.
    delete value.remainingPercentage;
  }
  return value;
}

function account(connectionId: string, priority: number, windows: NineRouterQuotaWindow[], modelLocks?: Record<string, string>): NineRouterAccountUsage {
  const value: NineRouterAccountUsage = {
    idHash: `hash-${connectionId}`,
    connectionId,
    priority,
    windows,
  };
  if (modelLocks) value.modelLocks = modelLocks;
  return value;
}

function cache(fetchedAt: number, providers: Record<string, NineRouterProviderUsage>): NineRouterUsageCache {
  return { version: 1, fetchedAt, total: {}, providers };
}

const NOW = 1_789_730_000_000;
const OBSERVED = NOW - 60_000;

function injection(modelId: string, providers: Record<string, NineRouterProviderUsage>) {
  return gatewayQuota(modelId, cache(OBSERVED, providers), NOW);
}

describe('gatewayQuota', () => {
  test('codex session mislabel relabeled weekly, reserveFraction 0.10, state healthy', () => {
    const result = injection('openai-codex/gpt-6-astra', {
      codex: { accounts: [account('cx-1', 1, [window('session', 19, 67 * HOUR), window('spark-session', 100, 5 * DAY), window('spark-weekly', 100, 7 * DAY)])] },
    });
    expect(result.state).toBe('healthy');
    expect(result.accounts?.length).toBe(1);
    expect(result.accounts?.[0]?.locked).toBe(false);
    const weekly = result.windows?.find(value => value.id === 'weekly');
    expect(weekly).toBeDefined();
    expect(weekly?.reserveFraction).toBe(0.10);
    expect(weekly?.remainingFraction).toBeCloseTo(0.19);
    // Spark meters are irrelevant for the main Codex meter and stay outside windows[].
    expect(result.windows?.find(value => value.id === 'spark-session')).toBeUndefined();
    // horizon = resetAt - OBSERVED (capture); the factory adds from NOW = OBSERVED+60s.
    expect(weekly?.horizonMs).toBe(67 * HOUR + 60_000);
  });

  test('codex weekly at 9% remaining is reserve', () => {
    const result = injection('openai-codex/gpt-6-astra', {
      codex: { accounts: [account('cx-1', 1, [window('session', 9, 67 * HOUR)])] },
    });
    expect(result.state).toBe('reserve');
  });

  test('claude two accounts none locked -> healthy, pressures rank the 12h account higher', () => {
    const result = injection('anthropic/claude-fable-5-1', {
      claude: {
        accounts: [
          account('claude-p1', 1, [window('session-5h', 38, 12 * HOUR), window('weekly-fable-7d', 62, 66 * HOUR)]),
          account('claude-p2', 2, [window('session-5h', 92, 132 * HOUR), window('weekly-fable-7d', 94, 6 * DAY)]),
        ],
      },
    });
    expect(result.state).toBe('healthy');
    expect(result.accounts?.length).toBe(2);
    const first = result.accounts?.find(value => value.connectionId === 'claude-p1');
    const second = result.accounts?.find(value => value.connectionId === 'claude-p2');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Quota resetting sooner means spending now costs less quota per hour.
    expect(first!.pressure).toBeGreaterThan(second!.pressure);
    expect(result.accounts?.some(value => value.locked)).toBe(false);
  });

  test('model-locked account appears with locked:true, state from the free account only', () => {
    const result = injection('anthropic/claude-fable-5-1', {
      claude: {
        accounts: [
          account('claude-p1', 1, [window('session-5h', 38, 12 * HOUR), window('weekly-fable-7d', 62, 66 * HOUR)]),
          account('claude-p2', 2, [window('session-5h', 92, 132 * HOUR), window('weekly-fable-7d', 94, 6 * DAY)], { 'claude-fable-5-1': new Date(NOW + HOUR).toISOString() }),
        ],
      },
    });
    expect(result.state).toBe('healthy'); // 38%/12h account healthy, 92%/132h locked ignored
    expect(result.accounts?.length).toBe(2);
    const locked = result.accounts?.find(value => value.connectionId === 'claude-p2');
    expect(locked?.locked).toBe(true);
    expect(result.accounts?.find(value => value.connectionId === 'claude-p1')?.locked).toBe(false);
  });

  test('both claude accounts locked -> state depleted', () => {
    const result = injection('anthropic/claude-fable-5-1', {
      claude: {
        accounts: [
          account('claude-p1', 1, [window('session-5h', 38, 12 * HOUR)], { '___all': new Date(NOW + HOUR).toISOString() }),
          account('claude-p2', 2, [window('session-5h', 92, 132 * HOUR)], { 'claude-fable-5-1': new Date(NOW + HOUR).toISOString() }),
        ],
      },
    });
    expect(result.state).toBe('depleted');
    expect(result.accounts?.every(value => value.locked)).toBe(true);
  });

  test('cache elapsed past a reset still yields unknown remaining fractions', () => {
    // The capture happened BEFORE the reset (observedAt < resetAt <= now), so
    // the reading belongs to a window that has already rolled over: the
    // capacity evidence must be discarded even without a refresh.
    const stale = account('cx-1', 1, [{ ...window('session', 80, 0), resetAt: OBSERVED + 60_000 }]);
    // Stale-cache ceiling is NINE_ROUTER_STALE_MS (5min); keep within it.
    const result = gatewayQuota('openai-codex/gpt-6-astra', cache(OBSERVED, { codex: { accounts: [stale] } }), OBSERVED + 4 * 60_000);
    expect(result.windows?.length).toBe(1);
    expect(result.windows?.[0]?.id).toBe('session');
    expect(result.windows?.[0]?.remainingFraction).toBeUndefined();
    expect(result.windows?.[0]?.resetsAt).toBeDefined();
    expect(result.windows?.[0]?.usedFraction).toBeUndefined();
    expect(result.state).toBe('unknown');
  });

  test('two accounts: healthy capacity reported even when the other is in reserve', () => {
    // Defect: usable accounts' windows were flattened, so one account's
    // reserve window dragged a healthy account's report down to reserve.
    const result = injection('anthropic/claude-fable-5-1', {
      claude: {
        accounts: [
          account('claude-healthy', 1, [window('session-5h', 90, 4 * HOUR), window('weekly-fable-7d', 95, 6 * DAY)]),
          account('claude-reserve', 2, [window('session-5h', 5, 3 * HOUR)]),
        ],
      },
    });
    expect(result.state).toBe('healthy');
    // Windows speak for the best usable account only, not the union.
    expect(result.windows?.some(value => value.remainingFraction === 0.05)).toBe(false);
    expect(result.windows?.every(value => (value.remainingFraction ?? 1) >= 0.85)).toBe(true);
  });

  test('stale cache past its cutoff keeps unexpired exhaustion as depleted', () => {
    // Defect: the stale branch discarded every window, so an exhausted window
    // whose reset is still in the future became unknown-quota, unlocking the
    // model in policy. The tombstone must outlive positive-capacity freshness.
    const exhausted = account('cx-1', 1, [window('session', 0, 3 * HOUR)]);
    const result = gatewayQuota('openai-codex/gpt-6-astra', cache(OBSERVED, { codex: { accounts: [exhausted] } }), OBSERVED + 6 * 60_000);
    expect(result.state).toBe('depleted');
    const tombstone = result.windows?.find(value => value.id === 'session');
    expect(tombstone).toBeDefined();
    // Policy blocks on exhausted===true OR remainingFraction===0; the stale
    // tombstone carries the remaining=0 evidence with an unexpired reset.
    expect(tombstone?.remainingFraction).toBe(0);
    expect(tombstone?.resetsAt).toBeGreaterThan(OBSERVED + 6 * 60_000);
  });

  test('stale cache after an exhaustion reset reports unknown, not full', () => {
    // A passed reset is not evidence of a fresh full window: it is unknown.
    const exhausted = account('cx-1', 1, [{ ...window('session', 0, 0), resetAt: OBSERVED + 60_000 }]);
    const result = gatewayQuota('openai-codex/gpt-6-astra', cache(OBSERVED, { codex: { accounts: [exhausted] } }), OBSERVED + 6 * 60_000);
    expect(result.state).toBe('unknown');
    expect(result.windows).toEqual([]);
  });

  test('stale exhaustion on one account does not hide another account', () => {
    // Accounts are alternatives: A exhausted, B healthy -> the healthy
    // account's capacity must win over the exhausted tombstone.
    const exhausted = account('claude-x', 1, [window('session-5h', 0, 3 * HOUR)]);
    const healthy = account('claude-y', 2, [window('session-5h', 90, 4 * HOUR)]);
    const result = injection('anthropic/claude-fable-5-1', { claude: { accounts: [exhausted, healthy] } });
    expect(result.state).toBe('healthy');
    expect(result.windows?.every(value => (value.remainingFraction ?? 1) > 0)).toBe(true);
  });

  test('fully stale pool: all accounts known exhausted -> depleted; one merely stale -> unknown', () => {
    const a = account('claude-x', 1, [window('session-5h', 0, 3 * HOUR)]);
    const b = account('claude-y', 2, [window('session-5h', 0, 3 * HOUR)]);
    const all = gatewayQuota('anthropic/claude-fable-5-1', cache(OBSERVED, { claude: { accounts: [a, b] } }), OBSERVED + 6 * 60_000);
    expect(all.state).toBe('depleted');
    expect(all.accounts).toBeUndefined(); // stale branch: no per-account summaries claimed
    // Stale 2% remaining is not proof of exhaustion: b is unknown, so the pool is not known-depleted.
    const c = account('claude-y', 2, [window('session-5h', 2, 3 * HOUR)]);
    const partial = gatewayQuota('anthropic/claude-fable-5-1', cache(OBSERVED, { claude: { accounts: [a, c] } }), OBSERVED + 6 * 60_000);
    expect(partial.state).toBe('unknown');
  });

  test('provider marked unavailable keeps unexpired exhaustion instead of erasing it', () => {
    const a = account('cx-1', 1, [window('session', 0, 3 * HOUR)]);
    const result = injection('openai-codex/gpt-6-astra', { codex: { unavailable: true, accounts: [a] } });
    expect(result.state).toBe('depleted');
    expect(result.windows?.[0]?.resetsAt).toBeGreaterThan(NOW);
  });

  test('two models of one subscription report the same shared window key', () => {
    // Verified against live telemetry: Fable and Sonnet on one Claude account
    // both resolve weekly-7d to one allowance, so spending one spends the
    // other. A provider-level sibling count cannot see that.
    const a = account('claude-p1', 1, [window('session-5h', 81, 12 * HOUR), window('weekly-7d', 60, 66 * HOUR)]);
    const fable = injection('anthropic/claude-fable-5-1', { claude: { accounts: [a] } });
    const sonnet = injection('anthropic/claude-sonnet-5', { claude: { accounts: [a] } });
    const keyOf = (r: ReturnType<typeof injection>) => r.windows?.find(w => w.id === 'weekly-7d')?.sharedKey;
    expect(keyOf(fable)).toBeDefined();
    expect(keyOf(fable)).toBe(keyOf(sonnet));
    expect(keyOf(fable)).toContain('hash-claude-p1');
  });

  test('the same window on a different account is a different allowance', () => {
    const a = account('claude-p1', 1, [window('weekly-7d', 60, 66 * HOUR)]);
    const b = account('claude-p2', 2, [window('weekly-7d', 60, 66 * HOUR)]);
    const first = injection('anthropic/claude-sonnet-5', { claude: { accounts: [a] } });
    const second = injection('anthropic/claude-sonnet-5', { claude: { accounts: [b] } });
    expect(first.windows?.[0]?.sharedKey).not.toBe(second.windows?.[0]?.sharedKey);
  });
});

describe('refreshNineRouterUsage secret timeout isolation', () => {
  /**
   * A keychain hit returns in ~16ms, but a miss falls through to `op read`,
   * which costs 2.7-4.4s. While the secret read shared the HTTP timeout, the
   * background refresh (2500ms) aborted during its own credential fetch and
   * cached errors.auth, leaving gateway telemetry permanently unavailable.
   *
   * The reader below models a pending `op read` without any wall-clock delay:
   * it resolves only when the test releases it, or rejects when its signal
   * aborts, exactly as readSecretFromProcess does when it kills the child.
   */
  function gatedSecretRead() {
    let release = () => {};
    const read = (_reference: string, signal?: AbortSignal) => new Promise<string>((resolve, reject) => {
      release = () => resolve('gateway-password');
      if (signal?.aborted) { reject(new Error('unavailable')); return; }
      signal?.addEventListener('abort', () => reject(new Error('unavailable')), { once: true });
    });
    return { read, release: () => release() };
  }

  const respond: FetchLike = async (url) => {
    const target = String(url);
    if (target.endsWith('/api/auth/login')) return new Response(null, { status: 200, headers: { 'set-cookie': 'session=abc; Path=/' } });
    if (target.includes('/api/usage/stats')) {
      return Response.json({ totalRequests: 7, totalPromptTokens: 2, totalCompletionTokens: 3, totalCachedTokens: 4, totalCost: 5 });
    }
    if (target.endsWith('/api/providers')) return Response.json([]);
    return Response.json({});
  };

  test('secret read outliving the HTTP budget still produces a healthy snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nr-usage-'));
    const secret = gatedSecretRead();
    try {
      // timeoutMs is 100ms here: if the secret read were still charged to the
      // HTTP budget (the old behaviour) its signal would abort before release
      // and this snapshot would carry errors.auth instead of totals.
      const pending = refreshNineRouterUsage(root, { origin: 'https://gateway.test', timeoutMs: 100, force: true, fetch: respond, opRead: secret.read });
      // A real AbortSignal.timeout(100) is already armed, so this genuinely has
      // to outlast it; deterministic clock control cannot drive an abort that
      // the production code creates internally.
      await Bun.sleep(250);
      secret.release();
      const cache = await pending;
      expect(cache.errors).toBeUndefined();
      expect(cache.total?.requests).toBe(7);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('secretTimeoutMs is the budget that aborts a hung secret read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nr-usage-'));
    const secret = gatedSecretRead();
    try {
      // Never released: only the secret budget can end this read.
      const cache = await refreshNineRouterUsage(root, { timeoutMs: 2_500, secretTimeoutMs: 100, force: true, fetch: respond, opRead: secret.read });
      expect(cache.errors?.auth).toBe('unavailable');
      expect(cache.total?.requests).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the admin origin is configuration, not a shipped constant', () => {
  // Regression: the origin was briefly a hardcoded placeholder default, so an
  // unset environment silently pointed every credentialed admin call at a
  // non-existent host and every turn failed with a transport error.
  const withRoot = (settings: unknown, run: (root: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), 'nr-origin-'));
    try {
      if (settings !== undefined) writeFileSync(join(root, 'settings.json'), JSON.stringify(settings));
      run(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  };

  test('resolves from the gateway baseUrl already in settings', () => {
    withRoot({ gateway: { enabled: true, baseUrl: 'https://gateway.test/v1' } }, root => {
      expect(nineRouterOrigin(root)).toBe('https://gateway.test');
    });
  });

  test('missing, malformed or non-https configuration yields no origin rather than a guess', () => {
    withRoot(undefined, root => expect(nineRouterOrigin(root)).toBeUndefined());
    withRoot({ gateway: { enabled: true } }, root => expect(nineRouterOrigin(root)).toBeUndefined());
    withRoot({ gateway: { enabled: true, baseUrl: 'not a url' } }, root => expect(nineRouterOrigin(root)).toBeUndefined());
    withRoot({ gateway: { enabled: true, baseUrl: 'http://gateway.test/v1' } }, root => expect(nineRouterOrigin(root)).toBeUndefined());
  });

  test('an unconfigured origin reports unavailable and issues no request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nr-origin-'));
    try {
      let called = false;
      const cache = await refreshNineRouterUsage(root, {
        force: true,
        fetch: async () => { called = true; return Response.json({}); },
        opRead: async () => 'secret',
      });
      expect(called).toBe(false);
      expect(cache.errors?.auth).toBe('unavailable');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
