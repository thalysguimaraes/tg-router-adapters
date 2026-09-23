/**
 * Capability probe for a candidate model.
 *
 * Vetting a model is not reading a catalog row: it is running the model and
 * seeing whether it survives the things this router requires. A candidate is
 * unroutable for tool work until `goValidated` lists it, and this probe is what
 * earns that entry.
 *
 * Five checks, each a real gateway call, each mapping to a routing guard:
 *   instruction  — follows an exact-output instruction (rejection: none, but a
 *                  model that fails this is not a worker)
 *   tools        — completes a FULL round trip: emits a well-formed tool call,
 *                  receives a synthetic tool result, and grounds its final
 *                  answer in that result           (`validated.tools`)
 *   reasoning    — accepts a reasoning/effort hint without erroring
 *                                                        (`validated.reasoning`)
 *   longContext  — answers a needle question at ~32k of filler, proving the
 *                  advertised context is usable, not just declared. This
 *                  validates the tested band only, never the whole window.
 *   effortHint   — informational: whether the upstream accepts
 *                  `reasoning_effort`, so the router knows to omit it
 *
 * Deliberately cheap and deliberately not a benchmark: it answers "is this
 * model wired up correctly for our transport", never "is it smart". Quality
 * tiers stay a reviewed human decision. One arithmetic item is not a reasoning
 * benchmark and one needle is not a context-window certification, so the
 * result records exactly what was tested and under which fixture version.
 */
import { isObjectGuard } from './type-guards';

export const PROBE_CHECKS = ['instruction', 'tools', 'reasoning', 'longContext', 'effortHint'] as const;
export type ProbeCheck = (typeof PROBE_CHECKS)[number];

/**
 * Bumped whenever a check's request shape or judgement changes. A record
 * produced under an older fixture is not evidence about the current one.
 */
export const PROBE_FIXTURE_VERSION = 'probe-2';
/** Filler size of the longContext check; the only band this probe validates. */
export const PROBE_CONTEXT_BAND_TOKENS = 32_000;

export interface ProbeCheckResult {
  check: ProbeCheck;
  pass: boolean;
  detail: string;
  elapsedMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * What was actually established, and about which artifact. Evidence is only
 * about this exact model id, transport and fixture; regenerating the transport
 * or changing a check invalidates it rather than silently carrying over.
 */
export interface QualificationRecord {
  /** Wire model id as probed. */
  model: string;
  /** Versioned model id the gateway reported answering, when it reports one. */
  resolvedModel?: string;
  /** Transport/protocol the probe spoke. */
  transport: string;
  fixtureVersion: string;
  probedAt: string;
  /** Whether the upstream accepts `reasoning_effort`; false means the router omits it. */
  acceptsEffortHint: boolean;
  /** Fixture band the probe exercised. NOT the advertised window. */
  validatedContextTokens?: number;
  /** Provider-reported prompt_tokens of that check; the measured figure, kept apart from the fixture's approximation. */
  measuredInputTokens?: number;
  /** Full tool round trip: call -> synthetic result -> grounded answer. */
  toolRoundTrip: boolean;
}

export interface ProbeResult {
  model: string;
  probedAt: string;
  checks: ProbeCheckResult[];
  /** True only when every check passed. Tool + reasoning are what gate Go routing. */
  routable: boolean;
  /** Suggested settings entries; applying them is a separate, explicit act. */
  suggests: { goValidated: boolean; goVisionValidated: boolean };
  /** False means the router must not send `reasoning_effort` to this model. */
  acceptsEffortHint: boolean;
  /** Durable, versioned evidence for persistence alongside the settings entry. */
  qualification: QualificationRecord;
}

export interface ProbeOptions {
  baseUrl: string;
  apiKey: string;
  /** Wire model id as the gateway expects it, e.g. `ocg/glm-5.3-flash`. */
  wireModel: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Transport label recorded in the qualification record. */
  transport?: string;
}

interface Completion {
  content: string;
  toolCalls: Array<{ name: string; args: string }>;
  /** The provider's assistant message verbatim, for faithful replay on the next turn. */
  rawMessage?: Record<string, unknown>;
  finish?: string;
  reasoningTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Versioned model id the gateway reports; an alias can resolve elsewhere. */
  resolvedModel?: string;
}

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
};
/** Synthetic tool-result fixture. The temperature is unguessable, so citing it proves the result was read. */
const TOOL_CALL_ID = 'call_probe_1';
const TOOL_RESULT_TEMPERATURE = 17.4;

function parseCompletion(body: unknown): Completion | undefined {
  if (!isObjectGuard(body)) return undefined;
  const choices = body.choices;
  if (!Array.isArray(choices) || !choices.length) return undefined;
  const choice = choices[0];
  if (!isObjectGuard(choice)) return undefined;
  const message = isObjectGuard(choice.message) ? choice.message : undefined;
  const rawCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: Completion['toolCalls'] = [];
  for (const raw of rawCalls) {
    if (!isObjectGuard(raw)) continue;
    const fn = isObjectGuard(raw.function) ? raw.function : undefined;
    if (typeof fn?.name === 'string') toolCalls.push({ name: fn.name, args: typeof fn.arguments === 'string' ? fn.arguments : '' });
  }
  const usage = isObjectGuard(body.usage) ? body.usage : undefined;
  return {
    content: typeof message?.content === 'string' ? message.content : '',
    toolCalls,
    ...(message ? { rawMessage: message } : {}),
    ...(typeof choice.finish_reason === 'string' ? { finish: choice.finish_reason } : {}),
    ...(isObjectGuard(usage?.completion_tokens_details) && typeof usage.completion_tokens_details.reasoning_tokens === 'number'
      ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens } : {}),
    ...(typeof usage?.prompt_tokens === 'number' ? { promptTokens: usage.prompt_tokens } : {}),
    ...(typeof usage?.completion_tokens === 'number' ? { completionTokens: usage.completion_tokens } : {}),
    ...(typeof body.model === 'string' ? { resolvedModel: body.model } : {}),
  };
}

export async function probeModel(options: ProbeOptions): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const call = async (body: Record<string, unknown>): Promise<{ completion?: Completion; error?: string; fatal?: boolean; shapeRejected?: boolean }> => {
    try {
      const res = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: options.wireModel, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // The gateway may append an SSE terminator to a non-stream response.
      const raw = (await res.text()).replace(/\s*data:\s*\[DONE\]\s*$/, '');
      // An unsupported model id makes the upstream reject the whole ACCOUNT,
      // and 9Router then 401s every model on it for a cooldown window. Treat
      // any auth/unsupported signal as fatal and stop probing immediately
      // rather than spending the rest of the checks degrading a live provider.
      // 401/403 and a rejected request body both trigger an account-wide
      // cooldown at the gateway, so both must stop the run.
      if (res.status === 401 || res.status === 403 || /not supported|ModelError/i.test(raw)) {
        return { error: `unsupported-or-auth (http-${res.status})`, fatal: true };
      }
      if (res.status === 400 && /unknown field|invalid request body/i.test(raw)) {
        return { error: `request-shape-rejected (http-400)`, fatal: true, shapeRejected: true };
      }
      if (!res.ok) return { error: `http-${res.status}` };
      const completion = parseCompletion(JSON.parse(raw));
      return completion ? { completion } : { error: 'unparseable-response' };
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Unknown';
      return { error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : name };
    }
  };

  const checks: ProbeCheckResult[] = [];
  let aborted: string | undefined;
  let resolvedModel: string | undefined;
  let toolRoundTrip = false;
  const run = async (check: ProbeCheck, body: Record<string, unknown>, judge: (c: Completion) => { pass: boolean; detail: string }) => {
    if (aborted) { checks.push({ check, pass: false, detail: `skipped: ${aborted}`, elapsedMs: 0 }); return; }
    const startedAt = now();
    const { completion, error, fatal } = await call(body);
    const elapsedMs = now() - startedAt;
    if (fatal) aborted = error ?? 'provider rejected the model';
    if (!completion) { checks.push({ check, pass: false, detail: error ?? 'no response', elapsedMs }); return; }
    const verdict = judge(completion);
    // A truncated response is a probe-budget artefact, not a model failure.
    // Reasoning models spend completion tokens on reasoning_content first.
    if (!verdict.pass && completion.content.trim() === '' && completion.finish === 'length') {
      verdict.detail = `inconclusive: response truncated at max_tokens${completion.reasoningTokens ? ` after ${completion.reasoningTokens} reasoning tokens` : ''}`;
    }
    resolvedModel = completion.resolvedModel ?? resolvedModel;
    checks.push({ check, ...verdict, elapsedMs, ...(completion.promptTokens !== undefined ? { promptTokens: completion.promptTokens } : {}), ...(completion.completionTokens !== undefined ? { completionTokens: completion.completionTokens } : {}) });
  };

  await run('instruction',
    { messages: [{ role: 'user', content: 'Reply with exactly the word READY and nothing else.' }], max_tokens: 512 },
    c => ({ pass: /^\W*ready\W*$/i.test(c.content.trim()), detail: c.content.trim().slice(0, 60) || '(empty)' }));

  // Full round trip, not just "did it emit a call". Emitting a well-formed
  // call proves the request shape; it does not prove the model can consume the
  // tool RESULT, which is what every real turn after the first depends on. The
  // synthetic result carries a value the model cannot know otherwise, so a
  // grounded final answer is provable rather than plausible.
  if (aborted) {
    checks.push({ check: 'tools', pass: false, detail: `skipped: ${aborted}`, elapsedMs: 0 });
  } else {
    const startedAt = now();
    const userTurn = { role: 'user', content: 'What is the weather in Lisbon? Use the tool.' };
    const first = await call({ messages: [userTurn], tools: [WEATHER_TOOL], tool_choice: 'auto', max_tokens: 128 });
    if (first.fatal) aborted = first.error ?? 'provider rejected the model';
    resolvedModel = first.completion?.resolvedModel ?? resolvedModel;
    const emitted = first.completion?.toolCalls.find(t => t.name === 'get_weather');
    let verdict: { pass: boolean; detail: string };
    if (!first.completion) {
      verdict = { pass: false, detail: first.error ?? 'no response' };
    } else if (!emitted) {
      verdict = { pass: false, detail: `no tool call (finish=${first.completion.finish ?? '?'}, content="${first.completion.content.trim().slice(0, 40)}")` };
    } else {
      let city: unknown;
      try { const parsed: unknown = JSON.parse(emitted.args || '{}'); city = isObjectGuard(parsed) ? parsed.city : undefined; } catch { city = undefined; }
      if (typeof city !== 'string' || !/lisbon|lisboa/i.test(city)) {
        verdict = { pass: false, detail: `tool called with unexpected arguments: ${emitted.args.slice(0, 60)}` };
      } else {
        // Replay the provider's own assistant turn (ids, reasoning fields and
        // all) rather than a fabricated one: a fabricated turn tests our
        // synthetic result, not whether the real response round-trips.
        const returned = first.completion.rawMessage ?? {};
        const returnedCall = (Array.isArray(returned.tool_calls) ? returned.tool_calls : []).find((t: any) => t?.function?.name === 'get_weather') as any;
        const callId = typeof returnedCall?.id === 'string' ? returnedCall.id : TOOL_CALL_ID;
        const second = await call({
          messages: [
            userTurn,
            { ...returned, role: 'assistant', content: typeof returned.content === 'string' ? returned.content : '', tool_calls: [{ id: callId, type: 'function', function: { name: 'get_weather', arguments: emitted.args } }] },
            { role: 'tool', tool_call_id: callId, name: 'get_weather', content: JSON.stringify({ city, temperature_c: TOOL_RESULT_TEMPERATURE, conditions: 'clear' }) },
          ],
          tools: [WEATHER_TOOL],
          max_tokens: 256,
        });
        if (second.fatal) aborted = second.error ?? 'provider rejected the model';
        resolvedModel = second.completion?.resolvedModel ?? resolvedModel;
        const grounded = second.completion?.content.includes(String(TOOL_RESULT_TEMPERATURE)) === true;
        toolRoundTrip = grounded;
        verdict = grounded
          ? { pass: true, detail: `get_weather(city=${city}) -> grounded answer cites ${TOOL_RESULT_TEMPERATURE}C` }
          : { pass: false, detail: second.completion ? `tool result not used: "${second.completion.content.trim().slice(0, 60)}"` : `tool result turn failed: ${second.error ?? 'no response'}` };
      }
    }
    checks.push({ check: 'tools', ...verdict, elapsedMs: now() - startedAt });
  }

  // Reasoning is asked WITHOUT an effort hint. Sending `reasoning_effort` to a
  // Go model made the upstream reject the body ("unknown field \"thinking\"")
  // with a 400, which 9Router turns into an account cooldown, which then failed
  // the following check too. That measured our own request shape, not the
  // model. Hint support is probed separately and is not a routing gate.
  await run('reasoning',
    { messages: [{ role: 'user', content: 'A bat and ball cost 1.10 together. The bat costs 1.00 more than the ball. What does the ball cost? Reply with only the number.' }], max_tokens: 2048 },
    c => ({ pass: /0?\.0?5\b/.test(c.content), detail: c.content.trim().replace(/\s+/g, ' ').slice(0, 60) || '(empty)' }));

  // ~32k tokens of filler with one needle. Proves the transport carries a large
  // prompt and the model still attends to it.
  const needle = 'The access code for warehouse seven is PELICAN-4417.';
  const filler = Array.from({ length: 1600 }, (_, i) => `Line ${i}: routine inventory record, nothing of note.`).join('\n');
  await run('longContext',
    { messages: [{ role: 'user', content: `${filler}\n${needle}\n${filler}\n\nWhat is the access code for warehouse seven? Reply with only the code.` }], max_tokens: 512 },
    c => ({ pass: /PELICAN-4417/i.test(c.content), detail: c.content.trim().slice(0, 60) || '(empty)' }));

  // Effort-hint support is informational: knowing the upstream rejects
  // `reasoning_effort` tells the router not to send it, and must never be the
  // reason a model looks unroutable. Runs last so a rejection cannot cascade.
  if (aborted) {
    checks.push({ check: 'effortHint', pass: false, detail: `skipped: ${aborted}`, elapsedMs: 0 });
  } else {
    const startedAt = now();
    const { completion, error, shapeRejected } = await call({ messages: [{ role: 'user', content: 'Reply with exactly: OK' }], reasoning_effort: 'medium', max_tokens: 512 });
    checks.push({
      check: 'effortHint',
      pass: !!completion,
      detail: completion ? 'accepts reasoning_effort' : shapeRejected ? 'upstream rejects reasoning_effort; router must omit it' : (error ?? 'no response'),
      elapsedMs: now() - startedAt,
    });
  }

  const by = (check: ProbeCheck) => checks.find(c => c.check === check)?.pass === true;
  const probedAt = new Date(now()).toISOString();
  const acceptsEffortHint = by('effortHint');
  return {
    model: options.wireModel,
    probedAt,
    checks,
    // effortHint is informational and excluded from routability.
    routable: checks.filter(c => c.check !== 'effortHint').every(c => c.pass),
    // Go routing needs tools + reasoning specifically (see policy rejection rules).
    suggests: { goValidated: by('tools') && by('reasoning'), goVisionValidated: false },
    acceptsEffortHint,
    qualification: {
      model: options.wireModel,
      ...(resolvedModel !== undefined ? { resolvedModel } : {}),
      transport: options.transport ?? 'openai-chat-completions',
      fixtureVersion: PROBE_FIXTURE_VERSION,
      probedAt,
      acceptsEffortHint,
      // Only the band actually exercised; the advertised window stays unproven.
      ...(by('longContext') ? { validatedContextTokens: PROBE_CONTEXT_BAND_TOKENS } : {}),
      ...(by('longContext') && checks.find(c => c.check === 'longContext')?.promptTokens !== undefined ? { measuredInputTokens: checks.find(c => c.check === 'longContext')!.promptTokens } : {}),
      toolRoundTrip,
    },
  };
}
