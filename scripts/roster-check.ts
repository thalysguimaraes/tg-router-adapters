// Scheduled roster check. Writes a report and remembers which findings were
// already reported so a cron run only surfaces what is new. Never edits policy.
//
//   bun run roster-check            # print new findings, exit 0
//   bun run roster-check --all      # print every current finding
//
// State: ~/.omp/agent/personal-router/roster-state.json  (prices + seen ids)
// Report: ~/.omp/agent/personal-router/roster-report.json (latest full run)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { analyzeRoster, fetchCatalogs, ROSTER, type RosterReport } from '../core/roster-monitor';

const root = process.env.OMP_PERSONAL_ROUTER_HOME ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'), 'personal-router');
mkdirSync(root, { recursive: true, mode: 0o700 });
const stateFile = join(root, 'roster-state.json');
const reportFile = join(root, 'roster-report.json');

interface State { prices: Record<string, number>; seen: string[] }
const load = (): State => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return { prices: {}, seen: [] }; } };
const state = load();

// Only models the gateway actually serves can be candidates. models.dev lists
// everything a vendor publishes; probing an unroutable id 401s the account.
const servable = new Set<string>();
try {
  const catalog = JSON.parse(readFileSync(join(root, '9router-catalog.json'), 'utf8')) as { models?: Array<{ id?: unknown }> };
  for (const m of catalog.models ?? []) if (typeof m.id === 'string') servable.add(m.id.split('/').pop()!);
} catch {}

const { modelsDev, openrouter, sources } = await fetchCatalogs();
const findings = analyzeRoster({ roster: ROSTER, modelsDev, openrouter, servable: servable.size ? servable : undefined, previousPrices: state.prices });

// Remember current prices for next run's reprice detection.
const prices: Record<string, number> = { ...state.prices };
for (const ref of ROSTER) {
  const [provider, id] = ref.split('/', 2) as [string, string];
  const md = modelsDev.find(m => m.provider === (provider === 'openai-codex' ? 'openai' : provider) && m.id === id);
  if (md?.inputPerMtok !== undefined) prices[ref] = md.inputPerMtok;
}
const seen = new Set(state.seen);
const fresh = findings.filter(f => !seen.has(f.id));
const showAll = process.argv.includes('--all');
const shown = showAll ? findings : fresh;
writeFileSync(stateFile, JSON.stringify({ prices, seen: [...new Set([...state.seen, ...findings.map(f => f.id)])] }, null, 2) + '\n', { mode: 0o600 });

const failed = Object.entries(sources).filter(([, s]) => !s.ok);
if (failed.length) console.log(`sources unavailable: ${failed.map(([n, s]) => `${n} (${s.error})`).join(', ')}`);
if (!shown.length) { console.log(showAll ? 'no findings' : 'no new findings'); process.exit(0); }
console.log(`${shown.length} ${showAll ? '' : 'new '}roster finding(s) — proposals only, nothing changed:\n`);
for (const kind of ['stale', 'repriced', 'candidate'] as const) {
  const group = shown.filter(f => f.kind === kind);
  if (!group.length) continue;
  console.log(kind.toUpperCase());
  for (const f of group) console.log(`  ${f.model}\n    ${f.detail}`);
  console.log();
}
console.log(`full report: ${reportFile}`);
