import type { QuotaSnapshot, QuotaState, QuotaWindow } from './policy';
import { QUOTA_MAX_AGE_MS, pressure } from './policy';

/**
 * One model's quota view plus the account identity the router should steer to.
 * `profile` is Meridian's account alias; `accountOwner` names who owns the
 * account selection (native OMP credentials, Meridian, or the gateway).
 */
export interface QuotaEntry {
  quota: QuotaSnapshot;
  credentialId?: string;
  selected?: boolean;
  accounts?: Array<{ credentialId?: string; selected?: boolean; quota: QuotaSnapshot; profile?: string }>;
  profile?: string;
  accountOwner?: 'omp-native' | 'meridian' | 'gateway';
}

/** Report scopes are provider-specific: "shared" is not always provider-wide. */
export function scopedLimits(report: any, model: any): any[] {
  const modelId = String(model.id).toLowerCase();
  const family = ['fable', 'opus', 'sonnet', 'mythos'].find(x => modelId.includes(x));
  return (Array.isArray(report?.limits) ? report.limits : []).filter((limit: any) => {
    const scope = limit.scope ?? {};
    if (model.provider === 'anthropic') {
      return scope.shared === true || (family !== undefined && scope.tier === family) || scope.modelId?.toLowerCase() === modelId;
    }
    // OMP 18.1.16 gates normal Codex and Spark on separate meters in both directions.
    if (model.provider === 'openai-codex') {
      const spark = modelId.includes('spark');
      const sparkLimit = scope.tier === 'spark' || String(limit.id).startsWith('openai-codex:spark:');
      if (spark) return sparkLimit;
      if (sparkLimit || scope.tier || scope.modelId) return false;
      return scope.shared === true || limit.id === 'openai-codex:primary' || limit.id === 'openai-codex:secondary';
    }
    return scope.shared === true || scope.modelId === model.id || (!scope.modelId && !scope.tier);
  });
}

const fraction = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
export function usedFraction(amount: any): number | undefined {
  const a = amount ?? {};
  if (fraction(a.usedFraction)) return a.usedFraction;
  if (fraction(a.remainingFraction)) return 1 - a.remainingFraction;
  if (Number.isFinite(a.limit) && a.limit > 0) {
    if (Number.isFinite(a.used) && fraction(a.used / a.limit)) return a.used / a.limit;
    if (Number.isFinite(a.remaining) && fraction(a.remaining / a.limit)) return 1 - a.remaining / a.limit;
  }
  if (Number.isFinite(a.used) && a.unit === 'percent' && fraction(a.used / 100)) return a.used / 100;
  return undefined;
}

function reportForAccount(reports: any[], provider: string, account: any, accountCount: number) {
  const candidates = reports.filter(report => {
    if (report.provider !== provider) return false;
    const meta = report.metadata ?? {};
    // Never repair a conflicting stable identity with an email or singleton guess.
    if (account?.accountId && meta.accountId && account.accountId !== meta.accountId) return false;
    if (account?.orgId && meta.orgId && account.orgId !== meta.orgId) return false;
    if (account?.email && meta.email && account.email.toLowerCase() !== meta.email.toLowerCase() &&
        !(account.accountId && account.accountId === meta.accountId)) return false;
    return true;
  }).sort((a, b) => (Number.isFinite(b.fetchedAt) ? b.fetchedAt : 0) - (Number.isFinite(a.fetchedAt) ? a.fetchedAt : 0));
  const byId = candidates.filter(report => account?.accountId && account.accountId === report.metadata?.accountId);
  if (byId.length) return byId[0];
  const byEmail = candidates.filter(report => account?.email && account.email.toLowerCase() === report.metadata?.email?.toLowerCase());
  if (byEmail.length === 1) return byEmail[0];
  return accountCount <= 1 && candidates.length === 1 ? candidates[0] : undefined;
}

export function accountQuota(model: any, report: any, health: any, now = Date.now()): QuotaSnapshot {
  const validTimestamp = Number.isFinite(report?.fetchedAt) && report.fetchedAt <= now;
  const windows: QuotaWindow[] = scopedLimits(report, model).map((limit: any) => {
    const resetsAt = Number.isFinite(limit.window?.resetsAt) ? limit.window.resetsAt : undefined;
    const elapsedWithoutRefresh = resetsAt !== undefined && resetsAt <= now && report.fetchedAt < resetsAt;
    const usable = validTimestamp && !elapsedWithoutRefresh;
    const used = usable ? usedFraction(limit.amount) : undefined;
    // Explicit status wins over rounded percentages, matching native auth-storage.
    const exhausted = usable && limit.status && limit.status !== 'unknown' ? limit.status === 'exhausted' : undefined;
    return {
      id: limit.id, usedFraction: used, remainingFraction: used === undefined ? undefined : 1 - used,
      resetsAt, exhausted,
      reserveFraction: limit.scope?.tier === 'fable' ? .20 : limit.window?.durationMs >= 604800000 || limit.scope?.windowId === '7d' ? .15 : 0,
    };
  });
  const fresh = validTimestamp && now - report.fetchedAt <= QUOTA_MAX_AGE_MS;
  const depleted = windows.some(window => window.exhausted === true || (window.exhausted !== false && window.usedFraction === 1));
  let state: QuotaState = 'unknown';
  if (health?.state === 'depleted') state = 'depleted'; // Native live block / plan eligibility remains authoritative.
  else if (depleted) state = 'depleted'; // Known exhaustion lasts through its reset, even after freshness expires.
  else if (fresh && windows.length && windows.every(window => window.usedFraction !== undefined)) {
    state = windows.some(window => window.remainingFraction! <= window.reserveFraction!) ? 'reserve' : 'healthy';
  } else if (fresh && !windows.length && health?.state === 'reserve') state = 'reserve';
  return { observedAt: validTimestamp ? report.fetchedAt : 0, state, windows };
}

export async function inspectQuotas(ctx: any, models: any[], signal: AbortSignal): Promise<Map<string, QuotaEntry>> {
  const auth = ctx.modelRegistry.authStorage;
  const sessionId = ctx.sessionManager.getSessionId();
  let reports: any[] = [];
  try { reports = await auth.fetchUsageReports({ signal }) ?? []; } catch { /* absence remains unknown */ }
  const entries = await Promise.all(models.map(async model => {
    let health: any = { state: 'unknown', accounts: [] };
    try { health = await auth.getModelUsageHealth(model.provider, { modelId: model.id, sessionId, baseUrl: model.baseUrl, reserveFraction: 0, signal }); } catch {}
    const identities = auth.listOAuthAccounts(model.provider, sessionId);
    const accountHealth = Array.isArray(health?.accounts) ? health.accounts : [];
    const now = Date.now();
    const accounts = (accountHealth.length ? accountHealth : [{ state: health?.state }]).map((entry: any) => {
      const identity = identities.find((account: any) => account.credentialId === entry.credentialId);
      const report = reportForAccount(reports, model.provider, identity, Math.max(identities.length, accountHealth.length));
      return { credentialId: entry.credentialId, selected: !!entry.selected, quota: accountQuota(model, report, entry, now) };
    });
    const rank: Record<QuotaState, number> = { healthy: 0, reserve: 1, unknown: 2, depleted: 3 };
    accounts.sort((a: any, b: any) => rank[a.quota.state as QuotaState] - rank[b.quota.state as QuotaState] || Number(b.selected) - Number(a.selected) || pressure(b.quota, now) - pressure(a.quota, now));
    const chosen = accounts[0];
    return [`${model.provider}/${model.id}`, { quota: chosen?.quota ?? { observedAt: 0, state: 'unknown', windows: [] }, credentialId: chosen?.credentialId, selected: chosen?.selected, accounts }] as [string, QuotaEntry];
  }));
  return new Map(entries);
}

