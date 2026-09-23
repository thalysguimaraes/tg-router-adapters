/**
 * Roster monitor: compares the reviewed model roster against live catalogs and
 * emits a PROPOSAL. It never edits policy. Model qualification is a reviewed
 * decision (see QUALIFICATIONS in policy.ts); catalog discovery alone grants
 * nothing.
 *
 * Sources are structured JSON, not scraped HTML:
 *   - models.dev/api.json         — provider catalogs incl. opencode-go, with
 *                                   cost per Mtok, context, release date
 *   - openrouter.ai/api/v1/models — paid market prices per token
 *
 * Findings:
 *   stale      a roster model no longer exists at its provider
 *   repriced   a roster model's paid price moved by >= 25%
 *   candidate  a new/free model at a provider we already subscribe to, released
 *              recently, with context >= our floor
 */
import { MODELS } from './policy';

export interface CatalogModel {
  id: string;
  provider: string;
  inputPerMtok?: number;
  outputPerMtok?: number;
  context?: number;
  releaseDate?: string;
}

export interface RosterFinding {
  kind: 'stale' | 'repriced' | 'candidate';
  model: string;
  detail: string;
  /** Deterministic; the same catalogs always produce the same finding id. */
  id: string;
}

export interface RosterReport {
  checkedAt: string;
  sources: Record<string, { ok: boolean; models: number; error?: string }>;
  findings: RosterFinding[];
}

const PROVIDERS_WE_SUBSCRIBE = new Set(['opencode-go', 'openai', 'anthropic']);
const CANDIDATE_MAX_AGE_DAYS = 45;
const CANDIDATE_MIN_CONTEXT = 200_000;
const REPRICE_THRESHOLD = 0.25;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** models.dev: { provider: { models: { id: { cost:{input,output}, limit:{context}, release_date } } } } */
export function parseModelsDev(body: unknown): CatalogModel[] {
  if (typeof body !== 'object' || body === null) return [];
  const out: CatalogModel[] = [];
  for (const [provider, entry] of Object.entries(body as Record<string, unknown>)) {
    const models = (entry as { models?: Record<string, unknown> })?.models;
    if (typeof models !== 'object' || models === null) continue;
    for (const [id, raw] of Object.entries(models)) {
      const m = raw as { cost?: { input?: unknown; output?: unknown }; limit?: { context?: unknown }; release_date?: unknown };
      out.push({
        id, provider,
        ...(finite(m.cost?.input) ? { inputPerMtok: m.cost.input } : {}),
        ...(finite(m.cost?.output) ? { outputPerMtok: m.cost.output } : {}),
        ...(finite(m.limit?.context) ? { context: m.limit.context } : {}),
        ...(typeof m.release_date === 'string' ? { releaseDate: m.release_date } : {}),
      });
    }
  }
  return out;
}

/** openrouter: { data: [{ id, pricing:{prompt,completion} (USD per token, as strings), context_length }] } */
export function parseOpenRouter(body: unknown): CatalogModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: CatalogModel[] = [];
  for (const raw of data) {
    const m = raw as { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown }; context_length?: unknown };
    if (typeof m.id !== 'string') continue;
    const prompt = Number(m.pricing?.prompt), completion = Number(m.pricing?.completion);
    out.push({
      id: m.id, provider: 'openrouter',
      ...(Number.isFinite(prompt) ? { inputPerMtok: prompt * 1_000_000 } : {}),
      ...(Number.isFinite(completion) ? { outputPerMtok: completion * 1_000_000 } : {}),
      ...(finite(m.context_length) ? { context: m.context_length } : {}),
    });
  }
  return out;
}

/** Canonical roster ref -> where to look it up in each catalog. */
function lookups(ref: string): { modelsDev?: { provider: string; id: string }; openrouter?: string } {
  const [provider, id] = ref.split('/', 2) as [string, string];
  if (provider === 'opencode-go') return { modelsDev: { provider: 'opencode-go', id } };
  if (provider === 'openai-codex') return { modelsDev: { provider: 'openai', id }, openrouter: `openai/${id}` };
  if (provider === 'anthropic') return { modelsDev: { provider: 'anthropic', id }, openrouter: `anthropic/${id.replace(/-(\d)-(\d)$/, '-$1.$2')}` };
  return {};
}
export function analyzeRoster(input: {
  roster: readonly string[];
  modelsDev: CatalogModel[];
  openrouter: CatalogModel[];
  /**
   * Model ids the transport can actually reach, from the 9Router catalog.
   * A model present in a vendor catalog but absent here is unroutable: probing
   * it made the gateway return 401 for the whole account with a cooldown, so
   * candidates MUST be filtered by this when it is supplied.
   */
  servable?: ReadonlySet<string>;
  /** Last known paid prices, to detect repricing. Absent => first run, no reprice findings. */
  previousPrices?: Record<string, number>;
  now?: number;
}): RosterFinding[] {
  const now = input.now ?? Date.now();
  const findings: RosterFinding[] = [];
  const byProvider = new Map<string, Map<string, CatalogModel>>();
  for (const m of input.modelsDev) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, new Map());
    byProvider.get(m.provider)!.set(m.id, m);
  }
  const orById = new Map(input.openrouter.map(m => [m.id, m]));

  for (const ref of input.roster) {
    const where = lookups(ref);
    const md = where.modelsDev ? byProvider.get(where.modelsDev.provider)?.get(where.modelsDev.id) : undefined;
    const or = where.openrouter ? orById.get(where.openrouter) : undefined;
    if (where.modelsDev && !md && !or) {
      findings.push({ kind: 'stale', model: ref, id: `stale:${ref}`, detail: `not present at ${where.modelsDev.provider} on models.dev${where.openrouter ? ` nor as ${where.openrouter} on OpenRouter` : ''}` });
      continue;
    }
    const price = or?.inputPerMtok ?? md?.inputPerMtok;
    const previous = input.previousPrices?.[ref];
    if (finite(price) && finite(previous) && previous > 0) {
      const delta = (price - previous) / previous;
      if (Math.abs(delta) >= REPRICE_THRESHOLD) {
        findings.push({ kind: 'repriced', model: ref, id: `repriced:${ref}:${previous}:${price}`, detail: `input price ${previous.toFixed(3)} -> ${price.toFixed(3)} USD/Mtok (${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(0)}%)` });
      }
    }
  }

  // Candidates: recent, capable, at a provider we already pay for. Free ones are
  // flagged regardless of age because a free window is exactly what Union was.
  const rosterIds = new Set(input.roster.map(ref => ref.split('/', 2)[1]));
  for (const m of input.modelsDev) {
    if (!PROVIDERS_WE_SUBSCRIBE.has(m.provider) || rosterIds.has(m.id)) continue;
    // Unroutable models are not candidates. models.dev lists everything the
    // vendor publishes; the gateway serves a subset.
    if (input.servable && !input.servable.has(m.id)) continue;
    if ((m.context ?? 0) < CANDIDATE_MIN_CONTEXT) continue;
    const free = m.inputPerMtok === 0 && m.outputPerMtok === 0;
    const ageDays = m.releaseDate ? (now - Date.parse(m.releaseDate)) / 86_400_000 : Number.POSITIVE_INFINITY;
    if (!free && !(ageDays <= CANDIDATE_MAX_AGE_DAYS)) continue;
    findings.push({
      kind: 'candidate', model: `${m.provider}/${m.id}`, id: `candidate:${m.provider}/${m.id}`,
      detail: `${free ? 'FREE' : `in=${m.inputPerMtok} out=${m.outputPerMtok} USD/Mtok`}, ctx=${m.context}, released ${m.releaseDate ?? 'unknown'}${Number.isFinite(ageDays) ? ` (${ageDays.toFixed(0)}d ago)` : ''}`,
    });
  }
  return findings;
}

export async function fetchCatalogs(fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): Promise<{ modelsDev: CatalogModel[]; openrouter: CatalogModel[]; sources: RosterReport['sources'] }> {
  const sources: RosterReport['sources'] = {};
  const pull = async (name: string, url: string, parse: (body: unknown) => CatalogModel[]): Promise<CatalogModel[]> => {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (!res.ok) { sources[name] = { ok: false, models: 0, error: `http-${res.status}` }; return []; }
      const models = parse(await res.json());
      sources[name] = { ok: true, models: models.length };
      return models;
    } catch (error) {
      sources[name] = { ok: false, models: 0, error: error instanceof Error ? error.name : 'Unknown' };
      return [];
    }
  };
  const [modelsDev, openrouter] = await Promise.all([
    pull('models.dev', 'https://models.dev/api.json', parseModelsDev),
    pull('openrouter', 'https://openrouter.ai/api/v1/models', parseOpenRouter),
  ]);
  return { modelsDev, openrouter, sources };
}

export const ROSTER = Object.values(MODELS) as readonly string[];
