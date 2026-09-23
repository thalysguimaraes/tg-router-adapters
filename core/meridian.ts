import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { accountQuota, type QuotaEntry } from './quota';

const BASE = 'http://127.0.0.1:3456';
const PROFILES = ['personal', 'work'];
const FAMILIES = ['fable', 'opus', 'sonnet', 'mythos'];
const flights = new Map<string, Promise<Snapshot>>();
interface Window { type: string; utilization?: number; resetsAt?: number }
interface Profile { id: string; fetchedAt: number; unavailable: boolean; windows: Window[] }
interface Snapshot { checkedAt: number; profiles: Profile[] }
const observed = (value: unknown, now: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= now;

function profilesFrom(value: any, now: number): Profile[] {
  if (!Array.isArray(value)) return [];
  return value.filter(profile => profile && PROFILES.includes(profile.id)).map(profile => {
    const validObservation = observed(profile.fetchedAt, now);
    return {
      id: profile.id,
      fetchedAt: validObservation ? profile.fetchedAt : 0,
      unavailable: !validObservation || !!profile.error || !!profile.unavailable,
      windows: validObservation && Array.isArray(profile.windows) ? profile.windows.filter((window: any) => typeof window?.type === 'string').map((window: any) => ({
        type: window.type.toLowerCase(),
        utilization: typeof window.utilization === 'number' && Number.isFinite(window.utilization) && window.utilization >= 0 && window.utilization <= 1 ? window.utilization : undefined,
        resetsAt: typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? window.resetsAt : undefined,
      })) : [],
    };
  });
}

async function snapshot(file: string): Promise<Snapshot> {
  const now = Date.now();
  let cached: Snapshot | undefined;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (observed(value?.checkedAt, now) && Array.isArray(value?.profiles)) cached = { checkedAt: value.checkedAt, profiles: profilesFrom(value.profiles, now) };
  } catch {}
  if (cached && now - cached.checkedAt < 180000) return cached;
  const pending = flights.get(file);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const response = await fetch(`${BASE}/v1/usage/quota/all`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('meridian-unavailable');
      const body: any = await response.json();
      const checkedAt = Date.now();
      const result: Snapshot = { checkedAt, profiles: profilesFrom(body?.profiles, checkedAt) };
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      try { writeFileSync(temp, JSON.stringify(result) + '\n', { mode: 0o600 }); renameSync(temp, file); }
      catch { try { unlinkSync(temp); } catch {} }
      return result;
    } catch { return cached ?? { checkedAt: 0, profiles: [] }; }
  })();
  flights.set(file, promise);
  try { return await promise; } finally { if (flights.get(file) === promise) flights.delete(file); }
}

export async function inspectMeridian(models: any[], file: string, preferredProfile?: string, unavailableProfiles: Record<string, number> = {}): Promise<Map<string, QuotaEntry>> {
  const data = await snapshot(file);
  const now = Date.now();
  return new Map(models.filter(model => model.provider === 'anthropic').map(model => {
    const family = FAMILIES.find(value => model.id.includes(value));
    const accounts = PROFILES.map(alias => {
      const profile = data.profiles.find(entry => entry.id === alias);
      const limits = (profile?.windows ?? []).filter(window => {
        const scoped = FAMILIES.find(value => window.type.includes(value));
        return !scoped || scoped === family;
      }).map(window => ({
        id: `anthropic:${window.type}`,
        scope: { shared: !FAMILIES.some(value => window.type.includes(value)), tier: FAMILIES.find(value => window.type.includes(value)), windowId: window.type === 'five_hour' ? '5h' : '7d' },
        window: { resetsAt: window.resetsAt, durationMs: window.type === 'five_hour' ? 18000000 : 604800000 },
        amount: { usedFraction: window.utilization },
        status: window.utilization === undefined ? 'unknown' : window.utilization >= 1 ? 'exhausted' : 'ok',
      }));
      const report = profile ? { fetchedAt: profile.unavailable ? 0 : profile.fetchedAt, limits } : undefined;
      const quota = accountQuota(model, report, { state: 'unknown' }, now);
      if (family === 'fable' && !limits.some(limit => limit.scope.tier === 'fable')) quota.state = 'unknown';
      const blockedUntil = unavailableProfiles[alias];
      if (Number.isFinite(blockedUntil) && blockedUntil > now) {
        // A runtime rejection is independent of the usage snapshot's freshness and survives resume.
        quota.observedAt = now;
        quota.state = 'depleted';
        quota.windows = [...(quota.windows ?? []), { id: 'runtime-profile-backoff', exhausted: true, resetsAt: blockedUntil }];
      }
      return { profile: alias, quota };
    });
    const rank: any = { healthy: 0, reserve: 1, unknown: 2, depleted: 3 };
    const headroom = (account: any) => account.quota.windows.length ? Math.min(...account.quota.windows.map((window: any) => window.remainingFraction ?? 0)) : 0;
    accounts.sort((a, b) => rank[a.quota.state!] - rank[b.quota.state!] || Number(b.profile === preferredProfile) - Number(a.profile === preferredProfile) || headroom(b) - headroom(a));
    const selected = accounts[0]!;
    return [`${model.provider}/${model.id}`, { ...selected, accounts, accountOwner: 'meridian', quota: selected.quota }] as [string, QuotaEntry];
  }));
}

export function withMeridianProfile(model: any, profile: string, sessionId: string) {
  if (!PROFILES.includes(profile)) throw new Error('Invalid Meridian profile');
  return { ...model, baseUrl: `${BASE}/v1`, headers: { ...model.headers, 'x-meridian-agent': 'omp-router', 'x-meridian-profile': profile, 'x-session-affinity': sessionId } };
}
