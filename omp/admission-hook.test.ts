import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import personalRouter from './index';

/**
 * Hook-level admission. `admitAttempt` is unit-tested in pipeline.test.ts;
 * what is regressed here is the wiring, because the strand this covers was
 * invisible at the policy layer: a transient failure was folded into the
 * attempt's quota as `depleted`, so the final gate refused the only route the
 * session had and the turn dead-ended with no way forward.
 */
const MODEL = { provider: 'anthropic', id: 'claude-opus-5', contextWindow: 400_000, maxTokens: 8_192 };
const TERMINAL = '503 {"error":{"message":"[cc/claude-opus-5] [401]: Model claude-opus-5 is not supported"}}';

async function session(pin?: { model: string; effort: string }) {
  const root = mkdtempSync(join(tmpdir(), 'tg-router-admission-'));
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ enabled: true, goValidated: [] }));
  const handlers = new Map<string, Function[]>();
  const notices: string[] = [];
  const states: any[] = [];
  let aborts = 0;
  const pi: any = {
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    getThinkingLevel: () => 'high', setThinkingLevel: () => {}, getActiveTools: () => [], getAllTools: () => [],
    setModel: async () => true, registerCommand: () => {}, appendEntry: (_key: string, value: any) => states.push(value),
  };
  const ctx: any = {
    mode: 'default', model: MODEL, models: { current: () => MODEL, list: () => [MODEL] },
    sessionManager: {
      getSessionId: () => 'session-1', getEntries: () => [], getParentSessionId: () => undefined,
      getBranch: () => pin ? [{ type: 'custom', customType: 'personal-router-state', data: { pin } }] : [],
    },
    modelRegistry: { authStorage: { listOAuthAccounts: () => [], pinSessionOAuthAccount: () => {} } },
    getContextUsage: () => ({ tokens: 1_000 }),
    abort: () => { aborts += 1; },
    ui: { setStatus: () => {}, notify: (text: string) => notices.push(text) },
  };
  await (personalRouter as any)(pi, { root });
  const emit = async (name: string, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  await emit('session_start', {});
  const failWith = (errorMessage: string) =>
    emit('message_end', { message: { role: 'assistant', provider: 'anthropic', model: 'claude-opus-5', content: [], stopReason: 'error', errorMessage, error: errorMessage } });
  return { emit, failWith, notices, aborts: () => aborts, state: () => states.at(-1) ?? {} };
}

describe('a transient provider failure never strands the session', () => {
  test('pinned: a dropped connection does not refuse the next attempt', async () => {
    const s = await session({ model: 'anthropic/claude-opus-5', effort: 'high' });
    await s.failWith('Connection error.');
    await s.emit('before_provider_request', {});
    expect(s.aborts()).toBe(0);
  });

  test('automatic with no decision yet: a transport error does not refuse the next attempt', async () => {
    // No routing decision has been committed, so there is no record to check
    // against. That is "not decided yet", not "the route is wrong".
    const s = await session();
    await s.failWith('fetch failed');
    await s.emit('before_provider_request', {});
    expect(s.aborts()).toBe(0);
  });

  test('the transient failure is still recorded, so the next decision routes around it', async () => {
    const s = await session();
    await s.failWith('Connection error.');
    expect(s.state().unavailableModels?.['anthropic/claude-opus-5']).toBeGreaterThan(Date.now());
    expect(s.state().blockedModels).toBeUndefined();
  });
});

describe('a terminal provider failure does block', () => {
  test('an unsupported model refuses the next attempt and releases a pin pointing at it', async () => {
    const s = await session({ model: 'anthropic/claude-opus-5', effort: 'high' });
    await s.failWith(TERMINAL);
    expect(s.state().pin).toBeUndefined();
    expect(s.state().blockedModels?.['anthropic/claude-opus-5']).toBeGreaterThan(Date.now());
    await s.emit('before_provider_request', {});
    expect(s.aborts()).toBe(1);
  });

  test('the same failure during a retry blocks before the retry budget is spent', async () => {
    // Retries emit no message_end, so this must be caught on auto_retry_start
    // or the host spends all ten attempts on a permanent condition.
    const s = await session({ model: 'anthropic/claude-opus-5', effort: 'high' });
    await s.emit('auto_retry_start', { attempt: 1, maxAttempts: 10, delayMs: 1_000, errorMessage: TERMINAL });
    expect(s.state().blockedModels?.['anthropic/claude-opus-5']).toBeGreaterThan(Date.now());
    await s.emit('before_provider_request', {});
    expect(s.aborts()).toBe(1);
  });

  test('a successful turn clears both the block and the backoff', async () => {
    const s = await session();
    await s.failWith(TERMINAL);
    await s.emit('message_end', { message: { role: 'assistant', provider: 'anthropic', model: 'claude-opus-5', content: [], stopReason: 'stop' } });
    expect(s.state().blockedModels?.['anthropic/claude-opus-5']).toBeUndefined();
    expect(s.state().unavailableModels?.['anthropic/claude-opus-5']).toBeUndefined();
  });
});
