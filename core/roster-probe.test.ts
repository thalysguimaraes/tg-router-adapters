import { describe, expect, test } from 'bun:test';
import { probeModel } from './roster-probe';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const message = (content: string) => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
const toolCall = (name: string, args: string) => ({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name, arguments: args } }] } }] });

const base = { baseUrl: 'https://gw.test/v1', apiKey: 'k', wireModel: 'ocg/x' };

describe('roster probe', () => {
  test('a fully working model passes every check and is suggested for validation', async () => {
    const result = await probeModel({
      ...base,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { tools?: unknown[]; messages: Array<{ role: string; content: string }> };
        const prompt = body.messages[0]!.content;
        // The second tool turn carries the synthetic result; a grounded answer must cite it.
        if (body.messages.some(m => m.role === 'tool')) return ok(message('It is 17.4C and clear in Lisbon.'));
        if (body.tools) return ok(toolCall('get_weather', '{"city":"Lisbon"}'));
        if (/READY/.test(prompt)) return ok(message('READY'));
        if (/bat and ball/.test(prompt)) return ok(message('0.05'));
        return ok(message('PELICAN-4417'));
      }) as unknown as typeof fetch,
    });
    expect(result.checks.every(c => c.pass)).toBe(true);
    expect(result.routable).toBe(true);
    expect(result.suggests.goValidated).toBe(true);
    expect(result.qualification.toolRoundTrip).toBe(true);
    expect(result.qualification.validatedContextTokens).toBe(32_000);
    expect(result.qualification.fixtureVersion).toBe('probe-2');
  });

  test('a model that emits a tool call but ignores the tool result fails tool support', async () => {
    // Emitting a call proves the request shape only. Every turn after the
    // first depends on the model consuming the RESULT.
    const result = await probeModel({
      ...base,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { tools?: unknown[]; messages: Array<{ role: string; content: string }> };
        if (body.messages.some(m => m.role === 'tool')) return ok(message('I am unable to check the weather right now.'));
        if (body.tools) return ok(toolCall('get_weather', '{"city":"Lisbon"}'));
        return ok(message('READY'));
      }) as unknown as typeof fetch,
    });
    const tools = result.checks.find(c => c.check === 'tools')!;
    expect(tools.pass).toBe(false);
    expect(tools.detail).toContain('tool result not used');
    expect(result.suggests.goValidated).toBe(false);
    expect(result.qualification.toolRoundTrip).toBe(false);
  });

  test('an unsupported model id aborts the probe instead of hammering the account', async () => {
    // Real behaviour observed on 2026-09-18: probing a model the gateway does
    // not serve made it return 401 for EVERY model on that account for 16s.
    // One request must be enough to stop.
    let calls = 0;
    const result = await probeModel({
      ...base,
      fetchImpl: (async () => {
        calls++;
        return new Response('{"error":{"message":"[401]: Model ox-alpha-free is not supported"}}', { status: 401 });
      }) as unknown as typeof fetch,
    });
    expect(calls).toBe(1);
    expect(result.routable).toBe(false);
    expect(result.checks[0]!.detail).toContain('unsupported-or-auth');
    expect(result.checks.slice(1).every(c => /^skipped:/.test(c.detail))).toBe(true);
  });

  test('a 200 response carrying an upstream ModelError is also fatal', async () => {
    let calls = 0;
    const result = await probeModel({
      ...base,
      fetchImpl: (async () => { calls++; return ok({ error: { message: 'ModelError: not supported' } }); }) as unknown as typeof fetch,
    });
    expect(calls).toBe(1);
    expect(result.checks.every(c => c.pass === false)).toBe(true);
  });

  test('tool support fails cleanly when the model answers in prose instead', async () => {
    const result = await probeModel({
      ...base,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { tools?: unknown[] };
        return body.tools ? ok(message('I cannot check the weather.')) : ok(message('READY'));
      }) as unknown as typeof fetch,
    });
    const tools = result.checks.find(c => c.check === 'tools')!;
    expect(tools.pass).toBe(false);
    expect(tools.detail).toContain('no tool call');
    // Tools are a routing gate, so a prose answer must not suggest validation.
    expect(result.suggests.goValidated).toBe(false);
  });

  test('a tool call with wrong arguments does not count as tool support', async () => {
    const result = await probeModel({
      ...base,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { tools?: unknown[] };
        return body.tools ? ok(toolCall('get_weather', '{"town":"Porto"}')) : ok(message('READY'));
      }) as unknown as typeof fetch,
    });
    expect(result.checks.find(c => c.check === 'tools')!.pass).toBe(false);
    expect(result.suggests.goValidated).toBe(false);
  });

  test('the SSE terminator some gateways append does not break parsing', async () => {
    const result = await probeModel({
      ...base,
      fetchImpl: (async () => new Response(JSON.stringify(message('READY')) + 'data: [DONE]', { status: 200 })) as unknown as typeof fetch,
    });
    expect(result.checks[0]!.pass).toBe(true);
  });
});

describe('effort hint is informational, never a routing gate', () => {
  const ok2 = (content: string) => new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] }), { status: 200 });
  test('a model that rejects reasoning_effort is still routable', async () => {
    // Measured on ocg/glm-5.3-flash: the upstream 400s on `thinking`, which
    // previously failed the reasoning check AND cascaded into the next one.
    const result = await probeModel({
      baseUrl: 'https://gw.test/v1', apiKey: 'k', wireModel: 'ocg/glm-5.3-flash',
      fetchImpl: (async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { tools?: unknown[]; reasoning_effort?: string; messages: Array<{ role: string; content: string }> };
        if (body.reasoning_effort) return new Response('{"error":{"message":"invalid request body: json: unknown field \\"thinking\\""}}', { status: 400 });
        if (body.messages.some(m => m.role === 'tool')) return ok2('It is 17.4C in Lisbon.');
        if (body.tools) return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'get_weather', arguments: '{"city":"Lisbon"}' } }] } }] }), { status: 200 });
        const prompt = body.messages[0]!.content;
        if (/READY/.test(prompt)) return ok2('READY');
        if (/bat and ball/.test(prompt)) return ok2('0.05');
        return ok2('PELICAN-4417');
      }) as unknown as typeof fetch,
    });
    expect(result.routable).toBe(true);
    expect(result.suggests.goValidated).toBe(true);
    expect(result.acceptsEffortHint).toBe(false);
    expect(result.checks.find(c => c.check === 'effortHint')!.detail).toContain('router must omit it');
  });
});
