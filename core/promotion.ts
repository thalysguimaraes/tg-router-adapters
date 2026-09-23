import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export type Promotion = { active: boolean; confirmedAt: number; source: string; providerExpiresAt: null };
const SOURCE = 'https://opencode.ai/go';
const MAX_AGE = 3600000;
const flights = new Map<string, Promise<Promotion>>();

export function freshPromotion(value: any, now = Date.now()): boolean {
  return value?.active === true && Number.isFinite(value.confirmedAt) && value.confirmedAt <= now && now - value.confirmedAt <= MAX_AGE;
}

function reusable(value: any, now: number): value is Promotion {
  return typeof value?.active === 'boolean' && Number.isFinite(value.confirmedAt) && value.confirmedAt <= now && now - value.confirmedAt < MAX_AGE && value.source === SOURCE && value.providerExpiresAt === null;
}

export async function getPromotion(cachePath: string): Promise<Promotion> {
  const pending = flights.get(cachePath);
  if (pending) return pending;
  const promise = refreshPromotion(cachePath);
  flights.set(cachePath, promise);
  try { return await promise; } finally { if (flights.get(cachePath) === promise) flights.delete(cachePath); }
}

async function refreshPromotion(cachePath: string): Promise<Promotion> {
  let cached: any;
  try { cached = JSON.parse(readFileSync(cachePath, 'utf8')); } catch {}
  if (reusable(cached, Date.now())) return cached;
  const unavailable: Promotion = { active: false, confirmedAt: 0, source: SOURCE, providerExpiresAt: null };
  try {
    const response = await fetch(SOURCE, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return unavailable;
    const html = await response.text();
    // Exclude scripts/styles/comments; require the named model and the exact current offer together.
    const text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ').replace(/&times;|&#215;|&#xD7;/gi, '×').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
    const active = /DeepSeek\s+V?4\.1\s+Flash\s+gets\s+4\s*[×x]\s+usage limits for a limited time/i.test(text);
    const result: Promotion = { active, confirmedAt: Date.now(), source: SOURCE, providerExpiresAt: null };
    const temp = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    // A cache write failure does not invalidate successfully verified provider evidence.
    try { writeFileSync(temp, JSON.stringify(result) + '\n', { mode: 0o600 }); renameSync(temp, cachePath); }
    catch { try { unlinkSync(temp); } catch {} }
    return result;
  } catch { return unavailable; }
}
