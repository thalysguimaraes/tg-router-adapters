import { expect, test } from 'bun:test';
import { errorDetails, unsupportedModel, installProviderDiagnostics, type DiagnosticEvent } from './diagnostics';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installNineRouter, NINEROUTER_BASE_URL } from './ninerouter';

function harness() {
  const handlers = new Map<string, Array<(event: DiagnosticEvent) => void>>();
  const logs: Array<Record<string, unknown>> = [], notices: Array<{ text: string; level: string }> = [];
  let updates = 0;
  const pi = {
    on(name: string, handler: (event: DiagnosticEvent) => void) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    sendMessage() { throw new Error('Diagnostics must not enqueue recovery turns'); },
    setModel() { throw new Error('Diagnostics must not route models'); },
  };
  const diagnostics = installProviderDiagnostics(pi, {
    log: (event, data) => logs.push({ event, ...data }),
    notify: (text, level) => notices.push({ text, level }),
    changed: () => { updates++; },
  });
  const emit = (name: string, data: DiagnosticEvent = {}) => { for (const handler of handlers.get(name) ?? []) handler(data); };
  const message = (stopReason: string, errorMessage = '') => emit('message_end', { message: { role: 'assistant', provider: '9router', model: 'cx/gpt-6-astra', content: [], stopReason, errorMessage } });
  return { diagnostics, emit, message, logs, notices, updates: () => updates };
}

test('successful HTTP status cannot leak into next transport failure; empty text remains visible through terminal settle', () => {
  const h = harness();
  h.emit('before_provider_request');
  h.emit('after_provider_response', { status: 200 });
  h.message('stop');
  h.emit('before_provider_request');
  h.message('error', 'Request timed out');
  expect(h.logs.findLast(row => row.event === 'provider-failure')).toMatchObject({ reason: 'timeout' });
  expect(h.logs.findLast(row => row.event === 'provider-failure')?.status).toBeUndefined();
  expect(h.notices.at(-1)?.level).toBe('error');
  const terminal = h.diagnostics.label;
  expect(terminal).toContain('timeout');
  h.emit('agent_end');
  expect(h.diagnostics.label).toBe(terminal);
});

test('a gateway-wrapped "model is not supported" 503 is terminal, not a retryable outage', () => {
  // Observed live: 9Router returns 503 whose body wraps the upstream 401
  // {"type":"error","error":{"type":"ModelError","message":"Model union-alpha
  // is not supported"}}. Classified as provider-unavailable it burned all ten
  // retries against a permanent condition.
  const body = '503 {"error":{"message":"[opencode-go/union-alpha] [401]: {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"ModelError\\",\\"message\\":\\"Model union-alpha is not supported\\"}} (reset after 2m)"}} retry-after-ms=120000';
  expect(unsupportedModel(body)).toBe(true);
  expect(errorDetails(body).reason).toBe('model-unsupported');
  expect(errorDetails(body).status).toBe(503);
  // A genuine 503 keeps its retryable classification.
  expect(errorDetails('503 upstream temporarily unavailable').reason).toBe('provider-unavailable');
  expect(unsupportedModel('the model is supported but overloaded')).toBe(false);
});

test('native retry and fallback replace failure status, success clears it, exhausted retry preserves failure', () => {
  const h = harness();
  h.message('error');
  expect(h.diagnostics.failure?.reason).toBe('provider-error');
  h.emit('auto_retry_start', { attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: 'HTTP 503' });
  expect(h.diagnostics.failure).toBeUndefined();
  expect(h.diagnostics.label).toContain('1/3');
  h.emit('retry_fallback_applied', { from: '9router/cx/gpt-6-astra', to: '9router/cx/gpt-5.6-sol', role: 'default' });
  expect(h.diagnostics.label).toContain('fallback');
  h.message('stop');
  h.emit('retry_fallback_succeeded', { model: '9router/cx/gpt-5.6-sol', role: 'default' });
  h.emit('auto_retry_end', { success: true, attempt: 1 });
  expect(h.diagnostics.label).toBeUndefined();
  h.message('error', 'HTTP 429');
  h.emit('auto_retry_end', { success: false, attempt: 3, finalError: 'HTTP 429' });
  h.emit('agent_end');
  expect(h.diagnostics.failure?.status).toBe(429);
  expect(h.diagnostics.label).toContain('429');
});

test('diagnostics keep actual error status, classify causes and cancellation without logging raw messages or credentials', () => {
  const secret = 'DO_NOT_LOG_PRIVATE_KEY';
  const failure = Object.assign(new TypeError(`fetch failed Authorization: Bearer ${secret}`), {
    cause: Object.assign(new Error(`request body=${secret}`), { code: 'ETIMEDOUT' }),
    status: 504,
    headers: { authorization: secret },
  });
  const details = errorDetails(failure, 200);
  expect(details).toMatchObject({ errorType: 'TypeError', code: 'ETIMEDOUT', reason: 'timeout', status: 504, cancelled: false });
  expect(JSON.stringify(details)).not.toContain(secret);
  expect(errorDetails(new DOMException(secret, 'AbortError'))).toMatchObject({ reason: 'cancelled', cancelled: true });
  expect(errorDetails(new DOMException(secret, 'TimeoutError'))).toMatchObject({ reason: 'timeout', cancelled: false });
  const h = harness();
  h.message('error', `HTTP 503 {"headers":{"Authorization":"${secret}"},"request":"${secret}"}`);
  expect(h.diagnostics.failure?.status).toBe(503);
  expect(JSON.stringify([h.logs, h.notices])).not.toContain(secret);
});

test('native failure remains an error when upstream text mentions cancellation', () => {
  const h = harness();
  h.message('error', 'HTTP 503 upstream request aborted');
  expect(h.diagnostics.failure).toMatchObject({ status: 503, reason: 'provider-unavailable', cancelled: false });
  expect(h.notices.at(-1)?.level).toBe('error');
  h.emit('auto_retry_end', { success: false, finalError: 'HTTP 503 upstream request aborted' });
  expect(h.logs.at(-1)).toMatchObject({ event: 'provider-failure', cancelled: false });
  h.emit('message_end', { message: { role: 'assistant', stopReason: 'error', error: new DOMException('upstream aborted', 'AbortError') } });
  expect(h.notices.at(-1)?.level).toBe('error');
  h.message('aborted', 'Request cancelled');
  expect(h.diagnostics.failure?.cancelled).toBe(true);
  h.emit('auto_retry_end', { success: false, finalError: 'Retry cancelled' });
  expect(h.logs.at(-1)).toMatchObject({ event: 'provider-cancelled', cancelled: true });
  expect(h.notices.at(-1)?.level).toBe('info');
});

test('registered gateway transport logs safe cause details and rethrows original cancellation or failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'router-diagnostics-'));
  const logs: Array<Record<string, unknown>> = [];
  let provider: { models: Array<{ id: string }>; streamSimple: (model: object, context: object, options: object) => Promise<Response> } | undefined;
  try {
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ gateway: { enabled: true, baseUrl: 'https://gateway.test/v1' } }));
    writeFileSync(join(root, '9router-catalog.json'), JSON.stringify({ models: [{ id: 'cx/gpt-6-astra' }] }));
    writeFileSync(join(root, '9router-key'), 'test-only-private-key', { mode: 0o600 });
    const controller = installNineRouter({ registerProvider: (_name: string, value: NonNullable<typeof provider>) => { provider = value; } }, {
      root,
      log: (event: string, data: Record<string, unknown>) => logs.push({ event, ...data }),
      nativeStreamSimple: (model: { id: string }, _context: unknown, options: { fetch: typeof fetch }) => options.fetch(`${NINEROUTER_BASE_URL}/responses`, { method: 'POST', body: JSON.stringify({ model: model.id }) }),
    });
    expect(controller.enabled).toBe(true);
    if (!provider) throw new Error('Gateway provider missing');
    const registered = provider;
    const failed = Object.assign(new TypeError('fetch failed test-only-private-key'), { cause: { code: 'ETIMEDOUT' } });
    for (const error of [failed, new DOMException('test-only-private-key', 'AbortError')]) {
      await expect(registered.streamSimple(registered.models[0], {}, { fetch: async () => { throw error; } })).rejects.toBe(error);
    }
    const transport = logs.filter(row => row.event === 'ninerouter-transport-error');
    expect(transport[0]).toMatchObject({ errorType: 'TypeError', code: 'ETIMEDOUT', reason: 'timeout', cancelled: false });
    expect(transport[1]).toMatchObject({ errorType: 'AbortError', reason: 'cancelled', cancelled: true });
    expect(JSON.stringify(logs)).not.toContain('test-only-private-key');
    controller.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
