/**
 * Fan-out sidecar files: `${dir}/${agentId}.json` records the canonical model an
 * agent currently holds, the canonical models of its running children, and the
 * shared quota windows that work draws on.
 * Advisory only: readers treat any failure (missing file, corrupt JSON) as no data.
 */
import { mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SiblingHolders { canonicalRef: string; count: number }
export interface FanoutRecord {
  model: string;
  children?: Record<string, string>;
  /** `QuotaWindow.sharedKey` values the agent's current route consumes. */
  windows?: string[];
  /** Epoch ms of the write; a stale record must not debit capacity forever. */
  at?: number;
}

function readFanout(dir: string, agentId: string): FanoutRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, `${agentId}.json`), 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof (parsed as FanoutRecord).model === 'string') {
      return parsed as FanoutRecord;
    }
  } catch {}
  return undefined;
}

/** Count one held canonical model into the grouped list. */
function bump(acc: Map<string, number>, canonicalRef: string | undefined) {
  if (typeof canonicalRef === 'string' && canonicalRef) acc.set(canonicalRef, (acc.get(canonicalRef) ?? 0) + 1);
}

export function writeFanout(dir: string, agentId: string, model: string, children: Record<string, string> = {}, windows: string[] = []): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${join(dir, `${agentId}.json`)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ model, children, windows, at: Date.now() }), { encoding: 'utf8', mode: 0o600 } as const);
  renameSync(tmp, join(dir, `${agentId}.json`));
}

/** A record older than this cannot represent work still in flight. */
export const IN_FLIGHT_MAX_AGE_MS = 600_000;

/**
 * How many OTHER live agents are working against each shared quota window.
 * Keyed by `QuotaWindow.sharedKey`, so two agents on different models of one
 * subscription count against the same allowance — which a provider-level
 * sibling count cannot see. Stale records are ignored rather than trusted.
 */
export function readInFlightWindows(dir: string, agentId: string, now = Date.now()): Record<string, number> {
  const counts: Record<string, number> = {};
  let names: string[];
  try { names = readdirSync(dir); } catch { return counts; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (id === agentId) continue;
    const record = readFanout(dir, id);
    if (!record?.windows?.length) continue;
    if (typeof record.at !== 'number' || now - record.at > IN_FLIGHT_MAX_AGE_MS) continue;
    for (const key of record.windows) {
      if (typeof key === 'string' && key) counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

/** Live canonical models held by the parent and its other running children (excluding this agent). */
export function readSiblings(dir: string, agentId: string, parentId: string | undefined): SiblingHolders[] {
  if (!parentId) return [];
  const parent = readFanout(dir, parentId);
  if (!parent) return [];
  const counts = new Map<string, number>();
  bump(counts, parent.model);
  for (const [childId, childModel] of Object.entries(parent.children ?? {})) {
    if (childId === agentId) continue;
    bump(counts, childModel);
  }
  return [...counts].map(([canonicalRef, count]) => ({ canonicalRef, count }));
}

export function removeFanout(dir: string, agentId: string): void {
  try { unlinkSync(join(dir, `${agentId}.json`)); } catch { /* already absent */ }
}
