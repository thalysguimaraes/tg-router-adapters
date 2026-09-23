const ERROR_TYPES = ['Error', 'TypeError', 'AbortError', 'TimeoutError', 'APIError', 'APIConnectionError', 'APIConnectionTimeoutError', 'RateLimitError', 'InternalServerError', 'AuthenticationError', 'PermissionDeniedError', 'BadRequestError', 'NotFoundError', 'UnprocessableEntityError'];
const ERROR_CODES = ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'rate_limit_exceeded', 'insufficient_quota', 'invalid_api_key', 'context_length_exceeded'];
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const errorStatus = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
const identifier = (value: unknown): string | undefined => typeof value === 'string' && /^[\w./:-]{1,160}$/.test(value) ? value : undefined;
/**
 * An upstream that does not serve the requested model. 9Router wraps the
 * upstream's 401 in a 503, which the host treats as retryable, so a pinned
 * unsupported model burned all ten retries against a permanent condition.
 * Retrying cannot change the answer: the route itself is wrong.
 */
const UNSUPPORTED = /\bmodel\b[^.\n]{0,80}?\bis not supported\b|\bunsupported model\b|\bmodel_not_found\b|\bno such model\b|\bmodel\b[^.\n]{0,80}?\bdoes not exist\b/i;
export function unsupportedModel(error: unknown): boolean {
  const source = object(error), cause = object(source.cause);
  const text = [typeof error === 'string' ? error : source.message, cause.message, typeof source.error === 'string' ? source.error : undefined]
    .filter((value): value is string => typeof value === 'string').join(' ').slice(0, 8192);
  return UNSUPPORTED.test(text);
}

export type ProviderFailure = { errorType: string; code?: string; reason: string; status?: number; cancelled: boolean };
export function errorDetails(error: unknown, httpStatus?: number, signal?: AbortSignal | null): ProviderFailure {
  const source = object(error), cause = object(source.cause), signalReason = object(signal?.reason);
  const name = typeof source.name === 'string' ? source.name : '';
  const code = [source.code, cause.code].find((value): value is string => typeof value === 'string' && ERROR_CODES.includes(value));
  // ponytail: categorical reasons avoid leaking SDK request/header dumps; extend the allowlist for new failures.
  const text = [typeof error === 'string' ? error : source.message, cause.message].filter((value): value is string => typeof value === 'string').map(value => value.slice(0, 4096)).join(' ').toLowerCase();
  const status = errorStatus(source.status) ?? errorStatus(source.statusCode) ?? errorStatus(object(source.response).status) ?? errorStatus(cause.status) ?? errorStatus(Number(text.match(/(?:\bhttp(?:\s+status)?\s*[:=]?\s*|\bstatus(?:\s+code)?[\s:=]+|^)([45]\d{2})\b/)?.[1])) ?? errorStatus(httpStatus);
  const timeout = /timeout|timed?\s*out/i.test(`${name} ${code ?? ''} ${text}`) || signalReason.name === 'TimeoutError';
  const cancelled = !timeout && (signal?.aborted === true || name === 'AbortError' || code === 'ABORT_ERR');
  const reason = timeout ? 'timeout' : cancelled ? 'cancelled' : unsupportedModel(error) ? 'model-unsupported' : status === 429 || code === 'rate_limit_exceeded' || code === 'insufficient_quota' ? 'rate-limit' : status === 401 || status === 403 || code === 'invalid_api_key' ? 'authentication' : code === 'context_length_exceeded' ? 'context-limit' : status && status >= 500 ? 'provider-unavailable' : code || /fetch failed|network|connection/.test(text) ? 'transport-error' : 'provider-error';
  return { errorType: ERROR_TYPES.includes(name) ? name : 'Error', code, reason, status, cancelled };
}

export type DiagnosticEvent = {
  status?: number;
  headers?: Record<string, string>;
  message?: { role?: string; provider?: string; model?: string; content?: unknown[]; stopReason?: string; errorMessage?: unknown; error?: unknown };
  attempt?: number; maxAttempts?: number; delayMs?: number; success?: boolean; errorMessage?: unknown; finalError?: unknown;
  from?: string; to?: string; model?: string; role?: string;
};
type DiagnosticSink = {
  log: (event: string, data: Record<string, unknown>) => void;
  notify: (text: string, level: string) => void;
  changed: () => void;
};

export function installProviderDiagnostics(pi: { on: (name: string, handler: (event: DiagnosticEvent) => void) => void }, sink: DiagnosticSink) {
  let lastHttpStatus: number | undefined;
  let failure: ProviderFailure | undefined;
  let label: string | undefined;
  function clear(next?: string) { failure = undefined; label = next; sink.changed(); }
  function fail(error: unknown, model?: string, cancelled = false) {
    failure = errorDetails(error, lastHttpStatus);
    if (cancelled || failure.cancelled) {
      failure.cancelled = cancelled;
      failure.reason = cancelled ? 'cancelled' : failure.status && failure.status >= 500 ? 'provider-unavailable' : 'provider-error';
    }
    label = failure.cancelled ? 'cancelado' : `erro ${failure.status ?? failure.reason}`;
    sink.log(failure.cancelled ? 'provider-cancelled' : 'provider-failure', { model: identifier(model), ...failure });
    sink.notify(`Routing: ${failure.cancelled ? 'chamada cancelada' : 'falha do provedor'} (${failure.reason}${failure.status ? `; HTTP ${failure.status}` : ''}).`, failure.cancelled ? 'info' : 'error');
    sink.changed();
  }
  pi.on('before_provider_request', () => { lastHttpStatus = undefined; if (failure) clear(); });
  pi.on('after_provider_response', event => { lastHttpStatus = event.status; sink.log('provider-response', { status: event.status, actualProfile: identifier(event.headers?.['x-meridian-profile']) }); });
  pi.on('message_end', ({ message }) => {
    if (message?.role !== 'assistant') return;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') fail(message.error ?? message.errorMessage, message.provider && message.model ? `${message.provider}/${message.model}` : undefined, message.stopReason === 'aborted');
    else if (message.stopReason === 'stop' || message.stopReason === 'toolUse') clear();
  });
  pi.on('auto_retry_start', event => {
    const attempt = Number.isSafeInteger(event.attempt) ? event.attempt : undefined;
    const maxAttempts = Number.isSafeInteger(event.maxAttempts) ? event.maxAttempts : undefined;
    sink.log('auto_retry_start', { attempt, max_attempts: maxAttempts, delay_ms: Number.isFinite(event.delayMs) ? event.delayMs : undefined, ...errorDetails(event.errorMessage, lastHttpStatus) });
    lastHttpStatus = undefined;
    clear(`retry ${attempt ?? '?'}/${maxAttempts ?? '?'}`);
  });
  pi.on('auto_retry_end', event => {
    const cancelled = event.finalError === 'Retry cancelled';
    const finalError = cancelled ? new DOMException('Retry cancelled', 'AbortError') : event.finalError;
    sink.log('auto_retry_end', { success: event.success, attempt: event.attempt, ...(event.success ? {} : errorDetails(finalError, lastHttpStatus)) });
    if (event.success) clear();
    else if (event.finalError !== undefined || !failure) fail(finalError, undefined, cancelled);
  });
  pi.on('retry_fallback_applied', event => {
    sink.log('retry_fallback_applied', { from: identifier(event.from), model: identifier(event.to) });
    lastHttpStatus = undefined;
    clear('retry fallback');
  });
  pi.on('retry_fallback_succeeded', event => { sink.log('retry_fallback_succeeded', { model: identifier(event.model) }); clear(); });
  for (const event of ['session_start', 'session_switch']) pi.on(event, () => { lastHttpStatus = undefined; clear(); });
  return { get failure() { return failure; }, get label() { return label; } };
}
