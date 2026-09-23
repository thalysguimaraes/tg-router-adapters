import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { QuotaAccount, QuotaSnapshot, QuotaState, QuotaWindow } from './policy';

/**
 * The 9Router admin surface. Self-hosted and per-user, so it is a deployment
 * fact rather than a constant worth shipping: it is read from
 * `settings.json` (`gateway.baseUrl`, the same value the transport already
 * uses) and may be overridden by `OMP_NINEROUTER_ORIGIN`. Resolved once per
 * root and cached, so a caller cannot redirect credentials mid-flight.
 */
const originCache = new Map<string, string | undefined>();
export function nineRouterOrigin(root?: string): string | undefined {
  const override = process.env.OMP_NINEROUTER_ORIGIN;
  if (override) return safeOrigin(override);
  if (!root) return undefined;
  if (originCache.has(root)) return originCache.get(root);
  let resolved: string | undefined;
  try {
    const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
    resolved = safeOrigin(settings?.gateway?.baseUrl);
  } catch { resolved = undefined; }
  originCache.set(root, resolved);
  return resolved;
}
/** Only an absolute https origin is usable; anything else is no configuration at all. */
function safeOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : undefined;
  } catch { return undefined; }
}
export const NINE_ROUTER_USAGE_FILE = '9router-usage.json';
export const NINE_ROUTER_PASSWORD_REF = process.env.OMP_NINEROUTER_OP_REF ?? 'op://Personal/9Router/password';
export const NINE_ROUTER_CACHE_TTL_MS = 120_000;
export const NINE_ROUTER_STALE_MS = 300_000;
/**
 * Automatic refreshes are throttled to the cache TTL, not the stale cutoff.
 * Invariant: throttle <= policy quota freshness (180s) <= stale cutoff, so a
 * reading is always refresh-eligible before policy can call it unfresh.
 */
export const NINE_ROUTER_REFRESH_THROTTLE_MS = NINE_ROUTER_CACHE_TTL_MS;

const ACTIVE_PROVIDERS = new Set(['claude', 'codex', 'opencode-go', 'glm']);
const SAFE_ERROR = 'unavailable';

type JsonObject = Record<string, any>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface NineRouterQuotaWindow {
  id: string;
  used?: number;
  total?: number;
  remaining?: number;
  remainingPercentage?: number;
  resetAt?: number;
  unlimited?: boolean;
  exhausted?: boolean;
}

export interface NineRouterAccountUsage {
  /** A one-way identifier hash retained alongside provider metadata. */
  idHash?: string;
  windows: NineRouterQuotaWindow[];
  limitReached?: boolean;
  unavailable?: boolean;
  /** Full upstream connection id, captured from /api/providers. */
  connectionId?: string;
  /** Routing priority from /api/providers. */
  priority?: number;
  /** modelLock_<model> expiry (ISO string) captured from /api/providers. */
  modelLocks?: Record<string, string>;
}

export interface NineRouterProviderUsage {
  accounts: NineRouterAccountUsage[];
  unavailable?: boolean;
}

export interface NineRouterTotals {
  nominalCostUsd?: number;
  requests?: number;
  /** Prompt + completion tokens; cached tokens are reported separately. */
  tokens?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
}

export interface NineRouterUsageCache {
  version: 1;
  fetchedAt: number;
  total: NineRouterTotals;
  providers: Record<string, NineRouterProviderUsage>;
  errors?: {
    auth?: typeof SAFE_ERROR;
    stats?: typeof SAFE_ERROR;
    providers?: typeof SAFE_ERROR;
    usage?: typeof SAFE_ERROR;
  };
}

export type NineRouterCache = NineRouterUsageCache;

export interface NineRouterRefreshOptions {
  /** Admin origin override; defaults to the one resolved from settings.json. */
  origin?: string;
  /** Injectable for tests. The default is globalThis.fetch. */
  fetch?: FetchLike;
  /** Alias retained for callers that call the HTTP dependency a transport. */
  transport?: FetchLike;
  /** Injectable 1Password reader. Its result is held in memory for one refresh only. */
  opRead?: (reference: string, signal?: AbortSignal) => Promise<string> | string;
  /** Alias for opRead used by small harnesses. */
  readPassword?: (reference: string, signal?: AbortSignal) => Promise<string> | string;
  /** Injectable clock to make TTL and reset tests deterministic. */
  now?: () => number;
  /** Per-request HTTP timeout. */
  timeoutMs?: number;
  /**
   * Timeout for the secret read alone. It is deliberately separate from
   * `timeoutMs`: a cached keychain read returns in ~16ms, but a cache miss
   * falls through to `op read`, which costs 2.7-4.4s and may raise a biometric
   * prompt. Charging that to the HTTP budget made a 4s refresh abort during its
   * own credential fetch and cache `errors.auth`, which is what kept 9Router
   * telemetry permanently unavailable.
   */
  secretTimeoutMs?: number;
  /** Bypass this local cache only, never force/reset the upstream quota. */
  force?: boolean;
  /** Optional rolling 30-day total. It is explicitly period=30d, never calendar-month data. */
  includeRolling30d?: boolean;
}

interface Connection {
  id: string;
  provider: string;
  priority?: number;
  modelLocks?: Record<string, string>;
}

interface UsageResult {
  connection: Connection;
  account: NineRouterAccountUsage;
}

const isObject = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const numberValue = (value: unknown, minimum = 0): number | undefined => {
  if (finite(value) && value >= minimum) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= minimum) return parsed;
  }
  return undefined;
};

function cachePath(root: string): string {
  return join(root, NINE_ROUTER_USAGE_FILE);
}

function hashConnection(provider: string, id: string): string {
  return createHash('sha256').update(`${provider}\0${id}`).digest('hex');
}

function safeWindowId(value: unknown, index: number): string {
  const source = typeof value === 'string' ? value : '';
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return slug || `window-${index + 1}`;
}

function normalizeResetAt(value: unknown): number | undefined {
  const numeric = numberValue(value);
  if (numeric !== undefined) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}
function normalizeIsoExpiry(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function modelLocksFromProviderRow(row: JsonObject): Record<string, string> | undefined {
  const modelLocks: Record<string, string> = {};
  for (const [field, value] of Object.entries(row)) {
    if (!field.startsWith('modelLock_')) continue;
    const model = field.slice('modelLock_'.length).trim();
    if (!/^[a-z0-9_.:/-]{1,256}$/i.test(model)) continue;
    const expiry = normalizeIsoExpiry(value);
    if (expiry) modelLocks[model.toLowerCase()] = expiry;
  }
  return Object.keys(modelLocks).length > 0 ? modelLocks : undefined;
}

function sanitizedModelLocks(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const modelLocks: Record<string, string> = {};
  for (const [model, valueForModel] of Object.entries(value)) {
    if (!/^[a-z0-9_.:/-]{1,256}$/i.test(model)) continue;
    const expiry = normalizeIsoExpiry(valueForModel);
    if (expiry) modelLocks[model.toLowerCase()] = expiry;
  }
  return Object.keys(modelLocks).length > 0 ? modelLocks : undefined;
}

function normalizeRemainingPercentage(value: unknown): number | undefined {
  const numeric = numberValue(value);
  if (numeric === undefined || numeric > 100) return undefined;
  // The admin API names this value as a percentage, so 1 means one percent.
  return numeric;
}

function normalizeWindow(value: unknown, index: number): NineRouterQuotaWindow | undefined {
  if (!isObject(value)) return undefined;
  const unlimited = value.unlimited === true;
  const result: NineRouterQuotaWindow = { id: safeWindowId(value.label ?? value.id ?? value.name, index) };
  const used = numberValue(value.used);
  const total = numberValue(value.total);
  const remaining = numberValue(value.remaining);
  const remainingPercentage = normalizeRemainingPercentage(value.remainingPercentage);
  const resetAt = normalizeResetAt(value.resetAt ?? value.resetsAt);
  if (used !== undefined) result.used = used;
  if (total !== undefined) result.total = total;
  if (remaining !== undefined) result.remaining = remaining;
  if (remainingPercentage !== undefined) result.remainingPercentage = remainingPercentage;
  if (resetAt !== undefined) result.resetAt = resetAt;
  if (unlimited) result.unlimited = true;
  const reached = value.limitReached === true || (!unlimited && remainingPercentage === 0) ||
    (!unlimited && total !== undefined && total > 0 && remaining !== undefined && remaining <= 0);
  if (reached) result.exhausted = true;
  return result;
}

function accountFromUsage(connection: Connection, body: unknown): NineRouterAccountUsage {
  const root = isObject(body) ? body : {};
  const quotas = isObject(root.quotas) ? root.quotas : undefined;
  const windows = quotas
    ? Object.entries(quotas)
      .map(([label, value], index) => normalizeWindow({ ...(isObject(value) ? value : {}), label }, index))
      .filter((value): value is NineRouterQuotaWindow => !!value)
    : [];
  const account: NineRouterAccountUsage = {
    idHash: hashConnection(connection.provider, connection.id),
    windows,
    connectionId: connection.id,
  };
  if (connection.priority !== undefined) account.priority = connection.priority;
  if (connection.modelLocks && Object.keys(connection.modelLocks).length > 0) account.modelLocks = connection.modelLocks;
  if (typeof root.limitReached === 'boolean') account.limitReached = root.limitReached;
  // Missing quotas are unavailable evidence, not an empty/zero quota.
  if (!quotas || windows.length === 0) account.unavailable = true;
  return account;
}

function sanitizeWindow(value: unknown, index: number): NineRouterQuotaWindow | undefined {
  if (!isObject(value) || typeof value.id !== 'string') return undefined;
  const result: NineRouterQuotaWindow = { id: safeWindowId(value.id, index) };
  for (const key of ['used', 'total', 'remaining'] as const) {
    const item = numberValue(value[key]);
    if (item !== undefined) result[key] = item;
  }
  const percent = normalizeRemainingPercentage(value.remainingPercentage);
  if (percent !== undefined) result.remainingPercentage = percent;
  const resetAt = normalizeResetAt(value.resetAt);
  if (resetAt !== undefined) result.resetAt = resetAt;
  if (value.unlimited === true) result.unlimited = true;
  if (value.exhausted === true || result.remainingPercentage === 0 ||
      (result.total !== undefined && result.total > 0 && result.remaining !== undefined && result.remaining <= 0)) result.exhausted = true;
  return result;
}

function sanitizeAccount(value: unknown): NineRouterAccountUsage | undefined {
  if (!isObject(value)) return undefined;
  const windows = Array.isArray(value.windows) ? value.windows.map(sanitizeWindow).filter((item): item is NineRouterQuotaWindow => !!item) : [];
  const account: NineRouterAccountUsage = { windows };
  if (typeof value.idHash === 'string' && /^[a-f0-9]{16,128}$/i.test(value.idHash)) account.idHash = value.idHash.toLowerCase();
  if (typeof value.connectionId === 'string' && /^[^\s\u0000-\u001f\u007f]{1,256}$/.test(value.connectionId)) account.connectionId = value.connectionId;
  const priority = numberValue(value.priority, 0);
  if (priority !== undefined) account.priority = priority;
  const modelLocks = sanitizedModelLocks(value.modelLocks);
  if (modelLocks) account.modelLocks = modelLocks;
  if (typeof value.limitReached === 'boolean') account.limitReached = value.limitReached;
  if (value.unavailable === true || windows.length === 0) account.unavailable = true;
  return account;
}
function activeConnections(body: unknown): Connection[] {
  const root = Array.isArray(body) ? { connections: body } : isObject(body) ? body : {};
  const rows = Array.isArray(root.connections) ? root.connections : [];
  const seen = new Set<string>();
  const result: Connection[] = [];
  for (const row of rows) {
    if (!isObject(row) || row.isActive !== true || (typeof row.id !== 'string' && typeof row.id !== 'number')) continue;
    const provider = normalizeProvider(row.provider);
    if (!ACTIVE_PROVIDERS.has(provider)) continue;
    const id = String(row.id);
    const key = `${provider}\0${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const priority = numberValue(row.priority, 0);
    const modelLocks = modelLocksFromProviderRow(row);
    result.push({ id, provider, priority, modelLocks });
  }
  return result;
}

function sanitizeProvider(value: unknown): NineRouterProviderUsage | undefined {
  if (!isObject(value)) return undefined;
  const accounts = Array.isArray(value.accounts) ? value.accounts.map(sanitizeAccount).filter((item): item is NineRouterAccountUsage => !!item) : [];
  const provider: NineRouterProviderUsage = { accounts };
  if (value.unavailable === true || accounts.length === 0) provider.unavailable = true;
  return provider;
}

function sanitizeTotals(value: unknown): NineRouterTotals {
  if (!isObject(value)) return {};
  const result: NineRouterTotals = {};
  for (const [source, target] of [
    ['nominalCostUsd', 'nominalCostUsd'], ['requests', 'requests'], ['tokens', 'tokens'], ['totalTokens', 'totalTokens'],
    ['promptTokens', 'promptTokens'], ['completionTokens', 'completionTokens'], ['cachedTokens', 'cachedTokens'],
  ] as const) {
    const number = numberValue(value[source]);
    if (number !== undefined) result[target] = number;
  }
  return result;
}

function sanitizeErrors(value: unknown): NineRouterUsageCache['errors'] | undefined {
  if (!isObject(value)) return undefined;
  const result: NonNullable<NineRouterUsageCache['errors']> = {};
  for (const key of ['auth', 'stats', 'providers', 'usage'] as const) if (value[key] === SAFE_ERROR) result[key] = SAFE_ERROR;
  return Object.keys(result).length ? result : undefined;
}

function sanitizeCache(value: unknown): NineRouterUsageCache | undefined {
  if (!isObject(value) || !finite(value.fetchedAt) || value.fetchedAt < 0) return undefined;
  const providers: Record<string, NineRouterProviderUsage> = {};
  if (isObject(value.providers)) {
    for (const [name, provider] of Object.entries(value.providers)) {
      const normalized = normalizeProvider(name);
      if (!ACTIVE_PROVIDERS.has(normalized)) continue;
      const safe = sanitizeProvider(provider);
      if (safe) providers[normalized] = safe;
    }
  }
  return {
    version: 1,
    fetchedAt: value.fetchedAt,
    total: sanitizeTotals(value.total),
    providers,
    errors: sanitizeErrors(value.errors),
  };
}

/** Read only the sanitized cache; malformed or missing files remain unavailable. */
export function readNineRouterUsage(root: string): NineRouterUsageCache | undefined {
  try { return sanitizeCache(JSON.parse(readFileSync(cachePath(root), 'utf8'))); } catch { return undefined; }
}

function atomicWrite(root: string, cache: NineRouterUsageCache): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = cachePath(root);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(cache) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  } catch {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
  }
}

function emptyCache(fetchedAt = 0): NineRouterUsageCache {
  return { version: 1, fetchedAt, total: {}, providers: {} };
}

function markUnavailable(previous: NineRouterUsageCache | undefined, kind: keyof NonNullable<NineRouterUsageCache['errors']>, fetchedAt?: number): NineRouterUsageCache {
  const result = previous ? structuredClone(previous) as NineRouterUsageCache : emptyCache(fetchedAt ?? 0);
  if (fetchedAt !== undefined) result.fetchedAt = fetchedAt;
  result.errors = { ...(result.errors ?? {}), [kind]: SAFE_ERROR } as NineRouterUsageCache['errors'];
  if (kind === 'auth' || kind === 'providers' || kind === 'usage') {
    for (const provider of Object.values(result.providers)) {
      provider.unavailable = true;
      for (const account of provider.accounts) account.unavailable = true;
    }
  }
  return result;
}

function normalizeProvider(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function responseCookie(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
  const cookies = values.map(value => value.split(';', 1)[0]).filter(value => /^[^=;\s]+=[^;]*$/.test(value));
  return cookies.length ? cookies.join('; ') : undefined;
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(Math.max(100, Math.min(timeoutMs, 60_000)));
}

async function jsonRequest(fetchImpl: FetchLike, origin: string, path: string, init: RequestInit, timeoutMs: number, parseBody = true): Promise<{ response: Response; body: any }> {
  const response = await fetchImpl(`${origin}${path}`, { ...init, redirect: 'manual', signal: timeoutSignal(timeoutMs) });
  if (!response.ok) throw new Error(SAFE_ERROR);
  if (!parseBody) return { response, body: undefined };
  try { return { response, body: await response.json() }; } catch { throw new Error(SAFE_ERROR); }
}

/** Minimal surface of `Bun.spawn` this module needs, so no `any` is required. */
interface SpawnedProcess {
  stdout?: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}
interface SpawnCapableRuntime {
  spawn(argv: string[], options: { stdout: 'pipe'; stderr: 'pipe' }): SpawnedProcess;
}

function spawnCapableRuntime(): SpawnCapableRuntime | undefined {
  const globals: { Bun?: unknown } = globalThis;
  const runtime = globals.Bun;
  if (!runtime || typeof runtime !== 'object' || !('spawn' in runtime)) return undefined;
  // `in` narrows `spawn` to unknown; the typeof check is what establishes it is callable.
  if (typeof runtime.spawn !== 'function') return undefined;
  // Bun's own types are not in scope in this extension; the guards above
  // establish the only two members this module calls.
  const spawnCapable = runtime as unknown as SpawnCapableRuntime;
  return spawnCapable;
}

/**
 * Spawn one child process and return trimmed stdout. stdout never leaves this
 * call; on any failure the caller sees only SAFE_ERROR. Direct spawn, never a
 * shell, so a secret in argv is not exposed to shell history or expansion.
 */
async function readSecretFromProcess(argv: string[], signal: AbortSignal): Promise<string> {
  const runtime = spawnCapableRuntime();
  if (!runtime) throw new Error(SAFE_ERROR);
  let processHandle: SpawnedProcess | undefined;
  try {
    processHandle = runtime.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
    const stdout = processHandle.stdout ? new Response(processHandle.stdout).text() : Promise.resolve('');
    const abort = () => { try { processHandle?.kill(); } catch {} };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const [value, code] = await Promise.all([stdout, processHandle.exited]);
      if (signal.aborted || code !== 0) throw new Error(SAFE_ERROR);
      const secret = value.trim();
      if (!secret) throw new Error(SAFE_ERROR);
      return secret;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  } catch {
    try { processHandle?.kill(); } catch {}
    throw new Error(SAFE_ERROR);
  }
}

/**
 * Read one secret reference, preferring the macOS login keychain over `op`.
 *
 * Measured on this machine: `op read` costs 2.7-4.4s AND raises a Touch ID
 * prompt per call, because the CLI keeps no persistent session. The router
 * refreshes 9Router telemetry on a 120s throttle, so an `op`-only path prompts
 * roughly every two minutes for an entire session. `security` returns the same
 * secret in ~40ms with no prompt: the item is guarded by the already-unlocked
 * login keychain instead of a fresh biometric check.
 *
 * 1Password remains the source of truth. The keychain is only ever written from
 * a successful `op` read, so rotation flows one way: vault -> keychain. A
 * rotated item is picked up by `forceVaultRead`, which `/route key` uses.
 */
export async function readPasswordFromOp(
  reference: string,
  signal: AbortSignal,
  options: { forceVaultRead?: boolean } = {},
): Promise<string> {
  // The reference is the cache identity, so a rotated item reuses one entry.
  const service = `omp-router:${reference}`;
  const onDarwin = process.platform === 'darwin';
  if (onDarwin && !options.forceVaultRead) {
    try {
      return await readSecretFromProcess(['security', 'find-generic-password', '-s', service, '-w'], signal);
    } catch { /* cache miss: fall through to the vault */ }
  }
  const secret = await readSecretFromProcess(['op', 'read', reference], signal);
  if (onDarwin) {
    try {
      // -U updates in place rather than failing on a duplicate service.
      await readSecretFromProcess(
        ['security', 'add-generic-password', '-a', process.env.USER ?? 'omp', '-s', service,
          '-w', secret, '-U', '-D', 'omp router cached secret'],
        signal,
      );
    } catch { /* a cache miss next time is acceptable; never surface this */ }
  }
  return secret;
}

function totalsFromStats(value: unknown): NineRouterTotals | undefined {
  if (!isObject(value)) return undefined;
  const requests = numberValue(value.totalRequests);
  const promptTokens = numberValue(value.totalPromptTokens);
  const completionTokens = numberValue(value.totalCompletionTokens);
  const cachedTokens = numberValue(value.totalCachedTokens);
  const nominalCostUsd = numberValue(value.totalCost);
  const result: NineRouterTotals = {};
  if (requests !== undefined) result.requests = requests;
  if (promptTokens !== undefined) result.promptTokens = promptTokens;
  if (completionTokens !== undefined) result.completionTokens = completionTokens;
  if (cachedTokens !== undefined) result.cachedTokens = cachedTokens;
  if (nominalCostUsd !== undefined) result.nominalCostUsd = nominalCostUsd;
  if (promptTokens !== undefined && completionTokens !== undefined) {
    result.tokens = promptTokens + completionTokens;
    result.totalTokens = result.tokens;
  }
  return Object.keys(result).length ? result : undefined;
}

function isFresh(cache: NineRouterUsageCache | undefined, now: number): cache is NineRouterUsageCache {
  return !!cache && finite(cache.fetchedAt) && cache.fetchedAt <= now && now - cache.fetchedAt <= NINE_ROUTER_CACHE_TTL_MS;
}

/**
 * Fetch the active subscription telemetry once and atomically replace root/9router-usage.json.
 * A failed field is marked unavailable; it is never represented by invented zeroes.
 */
const inFlightRefreshes = new Map<string, Promise<NineRouterUsageCache>>();
export function refreshNineRouterUsage(root: string, options: NineRouterRefreshOptions = {}): Promise<NineRouterUsageCache> {
  const running=inFlightRefreshes.get(root);
  if(running)return running;
  const pending=refreshUsageOnce(root,options).finally(()=>inFlightRefreshes.delete(root));
  inFlightRefreshes.set(root,pending);
  return pending;
}
/** Login once and return a cookie-bound request helper for admin mutations (e.g. priority swaps). */
export async function nineRouterSession(options: { root?: string; origin?: string; fetch?: FetchLike; opRead?: (ref: string, signal?: AbortSignal) => Promise<string>; timeoutMs?: number } = {}): Promise<{ request: (path: string, init?: RequestInit) => Promise<any> } | undefined> {
  const origin = options.origin ?? nineRouterOrigin(options.root);
  if (!origin) return undefined;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const opRead = options.opRead ?? ((reference: string, signal?: AbortSignal) => readPasswordFromOp(reference, signal ?? timeoutSignal(timeoutMs)));
  let cookie: string;
  try {
    const password = String(await opRead(NINE_ROUTER_PASSWORD_REF, timeoutSignal(timeoutMs))).trim();
    if (!password) throw new Error(SAFE_ERROR);
    const login = await jsonRequest(fetchImpl, origin, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }, timeoutMs, false);
    cookie = responseCookie(login.response) ?? '';
    if (!cookie) throw new Error(SAFE_ERROR);
  } catch {
    return undefined;
  }
  return {
    request: (path: string, init: RequestInit = {}) => jsonRequest(fetchImpl, origin, path, { ...init, headers: { cookie, ...(init.headers ?? {}) } }, timeoutMs),
  };
}

async function refreshUsageOnce(root: string, options: NineRouterRefreshOptions = {}): Promise<NineRouterUsageCache> {
  const now = options.now ?? (() => Date.now());
  const observedAt = now();
  const previous = readNineRouterUsage(root);
  if (!options.force && isFresh(previous, observedAt)) return previous;
  const origin = options.origin ?? nineRouterOrigin(root);
  if (!origin) {
    // No configured gateway is unavailable evidence, not an empty quota.
    const unavailable = markUnavailable(previous, 'auth', observedAt);
    atomicWrite(root, unavailable);
    return unavailable;
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  // A cache miss must be able to pay for `op read` without eating the HTTP budget.
  const secretTimeoutMs = options.secretTimeoutMs ?? Math.max(timeoutMs, 15_000);
  const fetchImpl = options.fetch ?? options.transport ?? globalThis.fetch.bind(globalThis);
  const opRead = options.opRead ?? options.readPassword ?? ((reference: string, signal?: AbortSignal) => readPasswordFromOp(reference, signal ?? timeoutSignal(secretTimeoutMs)));
  let password: string;
  try {
    password = String(await opRead(NINE_ROUTER_PASSWORD_REF, timeoutSignal(secretTimeoutMs))).trim();
    if (!password) throw new Error(SAFE_ERROR);
  } catch {
    // Advance the attempt clock and mark any retained provider rows unavailable;
    // a failed login must not make an old healthy snapshot look fresh.
    const unavailable = markUnavailable(previous, 'auth', observedAt);
    atomicWrite(root, unavailable);
    return unavailable;
  }

  let cookie: string;
  try {
    const login = await jsonRequest(fetchImpl, origin, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }, timeoutMs, false);
    cookie = responseCookie(login.response) ?? '';
    if (!cookie) throw new Error(SAFE_ERROR);
  } catch {
    // Keep the password and response body out of errors and cache output.
    const unavailable = markUnavailable(previous, 'auth', observedAt);
    atomicWrite(root, unavailable);
    return unavailable;
  }

  let stats: NineRouterTotals | undefined;
  let statsFailed = false;
  try {
    const result = await jsonRequest(fetchImpl, origin, '/api/usage/stats?period=today', { headers: { cookie } }, timeoutMs);
    stats = totalsFromStats(result.body);
    if (!stats) throw new Error(SAFE_ERROR);
  } catch { statsFailed = true; }

  let connections: Connection[] = [];
  let providersFailed = false;
  try {
    const result = await jsonRequest(fetchImpl, origin, '/api/providers', { headers: { cookie } }, timeoutMs);
    connections = activeConnections(result.body);
  } catch { providersFailed = true; }

  const usageResults: UsageResult[] = [];
  let usageFailed = false;
  if (!providersFailed) {
    const results = await Promise.all(connections.map(async connection => {
      try {
        const result = await jsonRequest(fetchImpl, origin, `/api/usage/${encodeURIComponent(connection.id)}`, { headers: { cookie } }, timeoutMs);
        return { connection, account: accountFromUsage(connection, result.body) };
      } catch {
        usageFailed = true;
        return { connection, account: { idHash: hashConnection(connection.provider, connection.id), windows: [], unavailable: true } };
      }
    }));
    usageResults.push(...results);
  }

  const cache = previous ? structuredClone(previous) as NineRouterUsageCache : emptyCache();
  cache.version = 1;
  cache.fetchedAt = observedAt;
  cache.errors = undefined;
  if (stats) cache.total = stats;
  if (statsFailed) cache.errors = { ...(cache.errors ?? {}), stats: SAFE_ERROR };
  if (providersFailed) {
    cache.errors = { ...(cache.errors ?? {}), providers: SAFE_ERROR };
    for (const provider of Object.values(cache.providers)) {
      provider.unavailable = true;
      for (const account of provider.accounts) account.unavailable = true;
    }
  } else {
    const grouped: Record<string, NineRouterProviderUsage> = {};
    for (const { connection, account } of usageResults) {
      const provider = grouped[connection.provider] ?? (grouped[connection.provider] = { accounts: [] });
      provider.accounts.push(account);
    }
    cache.providers = grouped;
    if (usageFailed) cache.errors = { ...(cache.errors ?? {}), usage: SAFE_ERROR };
    for (const provider of Object.values(cache.providers)) {
      if (provider.accounts.some(account => account.unavailable)) provider.unavailable = true;
    }
  }
  if (!cache.errors || Object.keys(cache.errors).length === 0) cache.errors = undefined;
  atomicWrite(root, cache);
  return cache;
}

function providerKeysForModel(modelId: string): string[] {
  const normalized = modelId.toLowerCase().replace(/^9router\//, '');
  const provider = normalized.split('/', 1)[0];
  // Catalog aliases are provider-qualified; keep these exact before model-name heuristics.
  if (provider === 'cc' || provider === 'claude' || provider === 'anthropic') return ['claude'];
  if (provider === 'cx' || provider === 'codex' || provider === 'openai-codex') return ['codex'];
  if (provider === 'ocg' || provider === 'opencode-go') return ['opencode-go'];
  if (provider === 'glm' || provider === 'zai-coding-plan') return ['glm'];
  // Do not borrow quota from a different provider for an unknown qualified ref.
  if (normalized.includes('/')) return [];
  if (/claude|fable|sonnet|opus|mythos/.test(normalized)) return ['claude'];
  if (/codex|gpt-\d/.test(normalized)) return ['codex'];
  if (/deepseek|glm/.test(normalized)) return ['opencode-go'];
  return [provider].filter(value => ACTIVE_PROVIDERS.has(value));
}

function familyForModel(modelId: string): string | undefined {
  return ['fable', 'opus', 'sonnet', 'mythos'].find(value => modelId.toLowerCase().includes(value));
}

function windowRelevant(modelId: string, windowId: string): boolean {
  const model = modelId.toLowerCase();
  const id = windowId.toLowerCase();
  const family = familyForModel(model);
  if (model.includes('claude') || model.includes('fable') || model.includes('sonnet') || model.includes('opus') || model.includes('mythos')) {
    const named = ['fable', 'opus', 'sonnet', 'mythos'].find(value => id.includes(value));
    return !named || named === family;
  }
  if (model.includes('spark')) return id.includes('spark');
  if (model.includes('review')) return id.includes('review');
  // Main Codex must not inherit separate Spark or review meters.
  return !id.includes('spark') && !id.includes('review');
}

function windowFractions(window: NineRouterQuotaWindow): { used?: number; remaining?: number } {
  if (window.unlimited === true) return { used: 0, remaining: 1 };
  let remaining: number | undefined;
  if (window.remainingPercentage !== undefined && Number.isFinite(window.remainingPercentage)) remaining = Math.max(0, Math.min(1, window.remainingPercentage / 100));
  else if (window.total !== undefined && window.total > 0 && window.remaining !== undefined) remaining = Math.max(0, Math.min(1, window.remaining / window.total));
  let used: number | undefined;
  if (window.total !== undefined && window.total > 0 && window.used !== undefined) used = Math.max(0, Math.min(1, window.used / window.total));
  else if (remaining !== undefined) used = 1 - remaining;
  if (remaining === undefined && used !== undefined) remaining = 1 - used;
  if (used === undefined && remaining !== undefined) used = 1 - remaining;
  return { used, remaining };
}

/** Contract Reserve rule: id family, then horizon ridges computed from resetAt - observedAt. */
function reserveFraction(window: { id: string; resetAt?: number }, observedAt: number): number {
  const normalized = window.id.toLowerCase();
  if (normalized.includes('fable')) return 0.20;
  const horizon = window.resetAt !== undefined ? window.resetAt - observedAt : undefined;
  if (horizon !== undefined && horizon >= 5 * 24 * 3600_000) return 0.15;
  if (horizon !== undefined && horizon >= 24 * 3600_000) return 0.10;
  return 0;
}

/** Latest unexpired modelLock expiry (ms) for this model, or undefined when not locked. */
function modelLockUntil(account: NineRouterAccountUsage, modelId: string, now: number): number | undefined {
  if (!account.modelLocks) return undefined;
  // Locks are keyed by bare model id; strips a provider-qualified prefix.
  const bare = modelId.toLowerCase().split('/').pop()!;
  const ids = new Set([bare, modelId.toLowerCase(), '___all']);
  let latest: number | undefined;
  for (const [model, expiry] of Object.entries(account.modelLocks)) {
    if (!ids.has(model.toLowerCase())) continue;
    const until = typeof expiry === 'string' ? Date.parse(expiry) : undefined;
    if (until !== undefined && Number.isFinite(until) && until > now && (latest === undefined || until > latest)) latest = until;
  }
  return latest;
}

function windowIdOf(source: NineRouterQuotaWindow, observedAt: number): string {
  // 9router mislabels the Codex weekly meter as "session"; a long reset
  // horizon proves it is the weekly meter. Named spark ids stay untouched.
  if (source.id === 'session' && source.resetAt !== undefined && source.resetAt - observedAt > 24 * 3600_000) return 'weekly';
  return source.id;
}

function accountPressure(account: NineRouterAccountUsage, modelId: string, observedAt: number, now: number): number {
  const hours: number[] = [];
  for (const window of account.windows) {
    // Same scoping as account eligibility: irrelevant model-specific windows
    // and readings taken before a passed reset carry no headroom evidence.
    if (!windowRelevant(modelId, window.id)) continue;
    if (window.resetAt !== undefined && window.resetAt <= now && observedAt < window.resetAt) continue;
    const fractions = windowFractions(window);
    if (fractions.remaining === undefined) continue;
    const hoursToReset = window.resetAt !== undefined ? Math.max(1, (window.resetAt - observedAt) / 3600_000) : 1;
    hours.push(fractions.remaining / hoursToReset);
  }
  return hours.length ? Math.min(...hours) : -1;
}

/**
 * `provider:accountHash:windowId` — the identity of the underlying allowance.
 * Two models of the same subscription that map to the same window id are
 * spending one meter, so a caller can debit in-flight work against it. The
 * account hash is already non-reversible; no credential material is exposed.
 */
function sharedWindowKey(provider: string, account: NineRouterAccountUsage, windowId: string): string | undefined {
  const accountId = account.idHash ?? account.connectionId;
  return accountId ? `${provider}:${accountId}:${windowId}` : undefined;
}

function classifyAccount(account: NineRouterAccountUsage, modelId: string, observedAt: number, now: number, provider?: string): { state: QuotaState; windows: QuotaWindow[]; locked: boolean } {
  const windows: QuotaWindow[] = [];
  const lockUntil = modelLockUntil(account, modelId, now);
  const locked = lockUntil !== undefined;
  let unknown = account.unavailable === true || account.windows.length === 0;
  let depleted = account.limitReached === true;
  let reserve = false;
  for (const source of account.windows) {
    if (!windowRelevant(modelId, source.id)) continue;
    // A reading made before a window reset cannot establish the new window's
    // usage. Keep the reset timestamp but discard old capacity evidence.
    const elapsedWithoutRefresh = source.resetAt !== undefined && source.resetAt <= now && observedAt < source.resetAt;
    const fractions: { used?: number; remaining?: number } = elapsedWithoutRefresh ? {} : windowFractions(source);
    const horizon = source.resetAt !== undefined && source.resetAt > observedAt ? source.resetAt - observedAt : undefined;
    const id = windowIdOf(source, observedAt);
    const shared = provider ? sharedWindowKey(provider, account, id) : undefined;
    const window: QuotaWindow = {
      id,
      ...(shared ? { sharedKey: shared } : {}),
      usedFraction: fractions.used,
      remainingFraction: elapsedWithoutRefresh ? undefined : fractions.remaining,
      resetsAt: source.resetAt,
      reserveFraction: reserveFraction(source, observedAt),
      horizonMs: horizon,
      exhausted: elapsedWithoutRefresh ? undefined : source.exhausted === true,
    };
    windows.push(window);
    if (!elapsedWithoutRefresh && (source.exhausted === true || fractions.remaining === 0)) depleted = true;
    if (fractions.remaining === undefined) unknown = true;
    else if (fractions.remaining <= window.reserveFraction!) reserve = true;
  }
  // The lock travels as an explicit exhausted window with its own expiry so
  // policy keeps blocking while it is active even when capacity evidence is
  // stale, and stops blocking (unknown, not full) once it expires.
  if (locked) windows.push({ id: 'model-lock', exhausted: true, resetsAt: lockUntil });
  if (!windows.length) unknown = true;
  let state: QuotaState;
  if (depleted || locked) state = 'depleted';
  else if (unknown) state = 'unknown';
  else state = reserve ? 'reserve' : 'healthy';
  return { state, windows, locked };
}

/**
 * Negative evidence that survives telemetry failure: an account is blocked
 * when a model lock is unexpired or a relevant window is known exhausted with
 * its reset still ahead. The pool is depleted only when EVERY account is
 * blocked; an account with merely stale or missing capacity is unknown, which
 * is not healthy but also not proof of exhaustion.
 */
function retainedBlocking(accounts: Array<{ provider: string; account: NineRouterAccountUsage }>, modelId: string, observedAt: number, now: number): QuotaSnapshot {
  const unique = new Map<string, { provider: string; account: NineRouterAccountUsage }>();
  for (const entry of accounts) unique.set(entry.account.idHash ?? JSON.stringify(entry.account), entry);
  const classified = [...unique.values()].map(({ provider, account }) => ({ account, classification: classifyAccount(account, modelId, observedAt, now, provider) }));
  const blocked = classified.filter(({ classification }) =>
    classification.locked || (classification.state === 'depleted' &&
      classification.windows.some(window => window.resetsAt === undefined || window.resetsAt > now)));
  if (!classified.length || blocked.length < classified.length) return { observedAt, state: 'unknown', windows: [] };
  const best = blocked.reduce((a, b) =>
    a.account.priority !== undefined && (b.account.priority === undefined || a.account.priority <= b.account.priority) ? a : b);
  return { observedAt, state: 'depleted', windows: best.classification.windows };
}

/** Pure adapter from sanitized cache data to the policy's QuotaSnapshot contract. */
export function gatewayQuota(modelId: string, cache: NineRouterUsageCache | undefined | null, now = Date.now()): QuotaSnapshot {
  const observedAt = cache && finite(cache.fetchedAt) && cache.fetchedAt <= now ? cache.fetchedAt : 0;
  const keys = providerKeysForModel(modelId);
  // The provider key travels with each account so a window can be named by the
  // allowance it belongs to, not just by its local id.
  const owned = keys.flatMap(key => {
    const provider = cache?.providers?.[key];
    return provider ? (provider.accounts ?? []).map(account => ({ provider: key, account })) : [];
  });
  const providers = keys.map(key => cache?.providers?.[key]).filter((value): value is NineRouterProviderUsage => !!value);
  // Stale data and a failed refresh both lose positive capacity evidence but
  // NOT known exhaustion: an unreset window stays blocking until it rolls
  // over. After a reset, capacity is unknown, never assumed full.
  if (!observedAt || now - observedAt > NINE_ROUTER_STALE_MS || !providers.length || providers.some(provider => provider.unavailable === true)) {
    return retainedBlocking(owned, modelId, observedAt, now);
  }
  const uniqueAccounts = new Map<string, { provider: string; account: NineRouterAccountUsage }>();
  for (const entry of owned) uniqueAccounts.set(entry.account.idHash ?? JSON.stringify(entry.account), entry);
  const selected = [...uniqueAccounts.values()];
  if (!selected.length) return { observedAt, state: 'unknown', windows: [] };
  const selectedAccounts = selected.map(entry => entry.account);
  const classified = selected.map(entry => classifyAccount(entry.account, modelId, observedAt, now, entry.provider));
  // Locked accounts cannot serve this model. Among the rest, the best state
  // wins: Phase 3 priority steering makes the best usable account the one
  // 9router's fill-first will actually select.
  const usableResults = classified.filter(value => !value.locked && value.state !== 'depleted');
  const usable = usableResults.map(value => value.state);
  const state: QuotaState = !usable.length ? 'depleted'
    : usable.includes('healthy') ? 'healthy'
    : usable.includes('reserve') ? 'reserve'
    : 'unknown';
  const accountSummaries: QuotaAccount[] = classified.map((result, index) => {
    const account = selectedAccounts[index]!;
    return {
      connectionId: account.connectionId ?? account.idHash ?? '',
      priority: account.priority ?? Number.MAX_SAFE_INTEGER,
      state: result.state,
      pressure: accountPressure(account, modelId, observedAt, now),
      locked: result.locked,
    };
  });
  // Policy re-derives state from windows; only usable accounts' windows may
  // speak, otherwise one exhausted account blocks the whole provider. Windows
  // stay scoped to ONE account: accounts are alternatives, so report the best
  // usable one (state rank, then fill-first priority) instead of flattening.
  const stateRank: Record<QuotaState, number> = { healthy: 3, reserve: 2, unknown: 1, depleted: 0 };
  let best = -1;
  let bestIndex = -1;
  const priorityByAccount: Record<number, number> = {};
  classified.forEach((value, index) => {
    priorityByAccount[index] = selectedAccounts[index]!.priority ?? Number.MAX_SAFE_INTEGER;
  });
  usableResults.forEach((value, index) => {
    const priority = priorityByAccount[classified.indexOf(value)];
    const rank = stateRank[value.state] * 1_000_000_000 - priority;
    if (rank > best) { best = rank; bestIndex = index; }
  });
  const windows = bestIndex >= 0
    ? usableResults[bestIndex]!.windows
    : (usableResults.length ? usableResults : classified).flatMap(value => value.windows);
  return { observedAt, state, windows, accounts: accountSummaries };
}

/** Small on-demand CLI hook used by OMP's installer/runtime; output is sanitized. */
if ((import.meta as any).main) {
  const root = process.argv[2] ?? process.env.OMP_PERSONAL_ROUTER_HOME;
  if (!root) {
    process.stderr.write('9Router usage unavailable\n');
    process.exitCode = 1;
  } else {
    try {
      const cache = await refreshNineRouterUsage(root);
      process.stdout.write(JSON.stringify({ fetchedAt: cache.fetchedAt, providers: Object.keys(cache.providers), errors: cache.errors }) + '\n');
    } catch {
      process.stderr.write('9Router usage unavailable\n');
      process.exitCode = 1;
    }
  }
}
