import { randomUUID } from 'node:crypto';
import { BudgetLedger, estimateUpperBoundUsd, type CostForecast } from './budget';

export const GUARDED_OPENROUTER_API = 'personal-budget-openrouter';
export const GUARDED_OPENROUTER_MARKER = '__personalOpenRouterBudgetGuard';
type Rates = CostForecast['rates'];
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
interface GuardOptions {
  ledger: () => BudgetLedger;
  /** Effective upper-bound prices in USD/million, including long context and selected service tier. */
  ratesFor: (model: any, inputTokenBound: number, payload: any) => Rates;
  maxOutputTokens?: number;
  onEvent?: (event: string, data: Record<string, unknown>) => void;
  onBlocked?: (reason: string) => void;
}
interface StreamInstallerOptions extends GuardOptions {
  /** Import streamSimple from the same @oh-my-pi/pi-ai runtime as OMP. */
  nativeStreamSimple: (model: any, context: any, options?: any) => any;
  registerCustomApi: (api: string, streamSimple: (model: any, context: any, options?: any) => any, sourceId?: string) => void;
  unregisterCustomApis: (sourceId: string) => void;
}

function emit(options: GuardOptions, event: string, data: Record<string, unknown>) {
  try { options.onEvent?.(event, data); } catch { /* Observability must not break an already sent stream. */ }
}
function denied(options: GuardOptions, reason: string): Response {
  emit(options, 'budget-blocked', { reason });
  try { options.onBlocked?.(reason); } catch {}
  return new Response(JSON.stringify({ error: { message: `Personal OpenRouter budget: ${reason}`, code: 'personal_budget_blocked', type: 'budget_error' } }), { status: 402, headers: { 'content-type': 'application/json', 'x-personal-budget-blocked': '1' } });
}
function hasMediaOrReference(value: any): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasMediaOrReference);
  if (typeof value.type === 'string' && /(?:image|audio|video|file|item_reference)/i.test(value.type)) return true;
  return Object.entries(value).some(([key, item]) => item != null && (/^(?:image_url|input_audio|video_url|file_data|file_id|audio)$/.test(key) || hasMediaOrReference(item)));
}

/** Each call is one actual POST, including native transport retries. Credentials only pass through. */
export function createGuardedFetch(model: any, baseFetch: Fetch, options: GuardOptions): Fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.origin !== 'https://openrouter.ai') return denied(options, 'unexpected-provider-origin');
    if (method !== 'POST') return baseFetch(input, init);
    if (!['/api/v1/chat/completions', '/api/v1/responses'].includes(url.pathname)) return denied(options, 'unsupported-billable-endpoint');
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    let payload: any, estimate: number, body: string;
    try {
      const originalBody = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : undefined;
      if (originalBody === undefined) return denied(options, 'unsupported-request-body');
      payload = JSON.parse(originalBody);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return denied(options, 'invalid-request-body');
      if (payload.model !== model.id || payload.models !== undefined || payload.route !== undefined) return denied(options, 'unapproved-model-or-fallback');
      if (payload.n !== undefined && payload.n !== 1) return denied(options, 'multiple-output-generations');
      if (payload.service_tier != null && !['auto', 'default'].includes(payload.service_tier)) return denied(options, 'unpriced-service-tier');
      payload.service_tier = 'default';
      if (hasMediaOrReference(payload.messages) || hasMediaOrReference(payload.input) || hasMediaOrReference(payload.instructions) || payload.prompt) return denied(options, 'unbounded-media-or-stored-input');
      // Server-side extras have costs outside the token tariff. Native function tools remain supported.
      if (payload.plugins?.length || payload.web_search_options || payload.modalities?.some((x: string) => x !== 'text') ||
          payload.tools?.some((tool: any) => tool.type && tool.type !== 'function')) return denied(options, 'unbounded-provider-extras');
      const configuredCap = options.maxOutputTokens ?? 32768;
      const nativeCap = Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : configuredCap;
      const cap = Math.min(nativeCap, configuredCap);
      if (!Number.isSafeInteger(cap) || cap <= 0) return denied(options, 'invalid-output-cap');
      const key = 'max_output_tokens' in payload ? 'max_output_tokens' : 'max_completion_tokens' in payload ? 'max_completion_tokens' : url.pathname.endsWith('/responses') ? 'max_output_tokens' : 'max_tokens';
      const requested = payload[key] ?? cap;
      if (!Number.isSafeInteger(requested) || requested <= 0) return denied(options, 'invalid-output-limit');
      payload[key] = Math.min(requested, cap);
      for (const other of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
        if (payload[other] === undefined) continue;
        if (!Number.isSafeInteger(payload[other]) || payload[other] <= 0) return denied(options, 'invalid-output-limit');
        payload[other] = Math.min(payload[other], cap);
      }
      // Disallow stored remote context: a tiny previous_response_id payload is not the full billable prefix.
      if (payload.previous_response_id) return denied(options, 'unbounded-remote-context');
      const rates = options.ratesFor(model, Buffer.byteLength(JSON.stringify(payload), 'utf8'), payload);
      // This is an enforced provider-price ceiling, not a claim about the current model tariff.
      if (payload.provider != null && (typeof payload.provider !== 'object' || Array.isArray(payload.provider))) return denied(options, 'invalid-provider-preferences');
      const existing = payload.provider?.max_price ?? {};
      if (typeof existing !== 'object' || Array.isArray(existing)) return denied(options, 'invalid-provider-price-ceiling');
      const tighter = (key: string, ceiling: number) => {
        const prior = existing[key];
        if (prior === undefined) return ceiling;
        if (typeof prior !== 'number' || !Number.isFinite(prior) || prior < 0) throw new Error('Invalid existing price ceiling');
        return Math.min(prior, ceiling);
      };
      payload.provider = { ...payload.provider, max_price: { ...existing, prompt: tighter('prompt', rates.input), completion: tighter('completion', rates.output), request: 0, image: 0 } };
      body = JSON.stringify(payload);
      const inputBound = Buffer.byteLength(body, 'utf8');
      const outputBound = Math.max(...['max_tokens', 'max_completion_tokens', 'max_output_tokens'].map(key => payload[key] ?? 0));
      // The personal OpenAI/Claude loadout can charge 1.25x/2x base prompt price for cache writes.
      // A max_price.prompt filter caps the base tariff, not that cache-write premium.
      const forecastRates = { ...rates, cacheWrite: Math.max(rates.cacheWrite ?? 0, rates.input * 2) };
      estimate = estimateUpperBoundUsd({ inputTokens: inputBound, maxOutputTokens: outputBound, rates: forecastRates });
    } catch { return denied(options, 'invalid-or-unpriced-request'); }
    const requestId = randomUUID();
    let ledger: BudgetLedger;
    try {
      ledger = options.ledger();
      const hold = ledger.reserve(requestId, estimate);
      if (!hold.ok) return denied(options, hold.reason);
      if (signal?.aborted) { ledger.releaseBeforeDispatch(requestId); signal.throwIfAborted(); }
      if (!ledger.markDispatched(requestId)) return denied(options, 'duplicate-dispatch');
    } catch (error) {
      if (signal?.aborted) throw error;
      return denied(options, 'ledger-unavailable');
    }
    emit(options, 'budget-dispatched', { requestId, model: `${model.provider}/${model.id}`, estimateUsd: estimate });
    let response: Response;
    try { response = await baseFetch(input, { ...init, body, method }); }
    catch (error) { emit(options, 'budget-uncertain', { requestId, reason: 'transport-error' }); throw error; }
    if (!response.body) return response; // Unknown cost remains held, including empty error responses.
    return observeResponse(response, ledger, requestId, options);
  };
}

/** Passes bytes through unchanged; partial/cancelled streams retain their reservation. */
function observeResponse(response: Response, ledger: BudgetLedger, requestId: string, options: GuardOptions): Response {
  const sse = response.headers.get('content-type')?.includes('text/event-stream') ?? false;
  const decoder = new TextDecoder();
  let buffer = '', oversized = false, cost: number | undefined, generation: string | undefined, settled = false;
  function settleKnownCost() {
    if (settled || cost === undefined) return;
    try {
      const result = ledger.settle(requestId, cost);
      settled = true;
      emit(options, 'budget-settled', { requestId, generationId: generation, actualUsd: cost, overEstimateUsd: result.overEstimateUsd });
    } catch { emit(options, 'budget-observation-error', { requestId }); }
  }
  function inspect(value: any) {
    const candidateId = value?.id ?? value?.response?.id;
    if (typeof candidateId === 'string' && /^gen-[A-Za-z0-9_-]+$/.test(candidateId) && !generation) {
      generation = candidateId;
      try { ledger.attachGeneration(requestId, generation); } catch { emit(options, 'budget-observation-error', { requestId }); }
    }
    const usage = value?.usage ?? value?.response?.usage;
    if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) cost = usage.cost;
    if (value?.type === 'response.completed' || value?.type === 'response.incomplete') settleKnownCost();
  }
  function line(value: string) {
    if (!value.startsWith('data:')) return;
    const data = value.slice(5).trim();
    if (data === '[DONE]') { settleKnownCost(); return; }
    if (!data) return;
    try { inspect(JSON.parse(data)); } catch {}
  }
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (oversized) return;
      buffer += decoder.decode(chunk, { stream: true });
      if (sse) {
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      }
      if (buffer.length > 1048576) { oversized = true; buffer = ''; }
    },
    flush() {
      if (oversized) return;
      buffer += decoder.decode();
      if (sse) line(buffer); else { try { inspect(JSON.parse(buffer)); settleKnownCost(); } catch {} }
      if (!settled) emit(options, 'budget-uncertain', { requestId, generationId: generation, reason: 'provider-cost-unavailable-or-stream-incomplete' });
    },
  });
  return new Response(response.body!.pipeThrough(transform), { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Register a uniquely owned API transport; provider/auth/catalog ownership remains OpenRouter. */
export function installGuardedOpenRouter(options: StreamInstallerOptions): { apiId: string; dispose: () => void } {
  const apiId = `${GUARDED_OPENROUTER_API}-${randomUUID()}`;
  options.registerCustomApi(apiId, (model: any, context: any, streamOptions: any = {}) => {
      if (model.provider !== 'openrouter') throw new Error('Budget transport is only for OpenRouter');
      const nativeModel = { ...model, api: 'openrouter', [GUARDED_OPENROUTER_MARKER]: true };
      const guardedFetch = createGuardedFetch(nativeModel, streamOptions.fetch ?? globalThis.fetch, options);
      // The custom-API outer wrapper already acquired the native provider permit; do not acquire twice.
      return options.nativeStreamSimple(nativeModel, context, { ...streamOptions, fetch: guardedFetch, maxInFlightRequests: {}, statefulResponses: false, loopGuard: { ...streamOptions.loopGuard, enabled: false } });
  }, apiId);
  let disposed = false;
  return { apiId, dispose: () => { if (!disposed) { disposed = true; options.unregisterCustomApis(apiId); } } };
}

export function guardOpenRouterModel(model: any, apiId = GUARDED_OPENROUTER_API): any {
  if (model.provider !== 'openrouter') return model;
  return { ...model, api: apiId, [GUARDED_OPENROUTER_MARKER]: true };
}
