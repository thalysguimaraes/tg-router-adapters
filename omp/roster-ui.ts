/**
 * `/route roster` — review and vet roster findings without leaving omp.
 *
 * Vetting a candidate means running it, not reading a catalog row, so this
 * screen's real job is to get you from "a model appeared" to "probed, and the
 * routing gate flipped" in a few keystrokes. It shows findings, probes on
 * demand, prints per-check evidence, and only then offers to write the
 * `goValidated` entry that makes a Go model routable for tool work.
 *
 * Nothing here changes routing implicitly: every write is a confirm step.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeRoster, fetchCatalogs, ROSTER, type RosterFinding } from '../core/roster-monitor';
import { probeModel, type ProbeResult, type QualificationRecord } from '../core/roster-probe';
import { isObjectGuard } from '../core/type-guards';

export interface RosterUIContext {
  /** omp's extension UI surface (select / confirm / notify). */
  ui: {
    select(title: string, options: Array<{ label: string; description?: string }>, options2?: unknown): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  };
  /** Router home, for reports and settings. */
  root: string;
  /** Gateway base URL and key, for probing. */
  gateway?: { baseUrl: string; apiKey: string };
  /** Model ids the transport can actually serve, from the 9Router catalog. */
  servable: ReadonlySet<string>;
  /** Wire ref for a bare model id, e.g. deepseek-v4.1-flash -> ocg/deepseek-v4.1-flash. */
  wireRefFor(modelId: string): string | undefined;
  log(event: string, data?: unknown): void;
}

const KIND_ICON: Record<RosterFinding['kind'], string> = { stale: 'stale', repriced: 'price', candidate: 'new' };

function summarize(result: ProbeResult): string {
  return result.checks.map(c => `${c.pass ? '✓' : '✗'} ${c.check}`).join('  ');
}

/** Read the report written by the scheduled check; fall back to a live fetch. */
async function loadFindings(context: RosterUIContext): Promise<{ findings: RosterFinding[]; checkedAt: string; live: boolean }> {
  const reportFile = join(context.root, 'roster-report.json');
  try {
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { checkedAt: string; findings: RosterFinding[] };
    if (Array.isArray(report.findings)) return { findings: report.findings, checkedAt: report.checkedAt, live: false };
  } catch {}
  const { modelsDev, openrouter } = await fetchCatalogs();
  const state = (() => { try { return JSON.parse(readFileSync(join(context.root, 'roster-state.json'), 'utf8')) as { prices?: Record<string, number> }; } catch { return {}; } })();
  return { findings: analyzeRoster({ roster: ROSTER, modelsDev, openrouter, servable: context.servable, previousPrices: state.prices }), checkedAt: new Date().toISOString(), live: true };
}

function settingsPath(root: string): string { return join(root, 'settings.json'); }

/**
 * Flip the routing gate AND record what earned it. The settings entry alone
 * says nothing about which model version, transport or fixture was tested, so
 * evidence is stored next to it under the probed identity: a regenerated
 * transport or a bumped fixture no longer looks like a current qualification.
 */
function addGoValidated(root: string, modelId: string, qualification: QualificationRecord): { ok: boolean; detail: string } {
  const file = settingsPath(root);
  let settings: Record<string, unknown>;
  try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { return { ok: false, detail: 'settings.json unreadable' }; }
  const current = Array.isArray(settings.goValidated) ? settings.goValidated.filter((x): x is string => typeof x === 'string') : [];
  const records = isObjectGuard(settings.goQualifications) ? settings.goQualifications : {};
  settings.goQualifications = { ...records, [modelId]: qualification };
  const already = current.includes(modelId);
  if (!already) settings.goValidated = [...current, modelId];
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return { ok: true, detail: already ? `already validated; qualification updated (${qualification.fixtureVersion})` : `goValidated += ${modelId} (${qualification.fixtureVersion})` };
}

export async function showRoster(context: RosterUIContext): Promise<void> {
  const { findings, checkedAt, live } = await loadFindings(context);
  const age = Math.max(0, Math.round((Date.now() - Date.parse(checkedAt)) / 60_000));
  if (!findings.length) {
    context.ui.notify(`Roster sem pendências (verificado ${live ? 'agora' : `há ${age} min`}).`);
    return;
  }

  // Probe results accumulate across the session so re-entering the screen
  // keeps the evidence you already paid for.
  const probed = new Map<string, ProbeResult>();

  for (;;) {
    const options = findings.map(f => {
      const result = probed.get(f.model);
      return {
        label: `[${KIND_ICON[f.kind]}] ${f.model}`,
        description: result ? `${result.routable ? 'ROUTABLE' : 'not routable'} — ${summarize(result)}` : f.detail,
      };
    });
    options.push({ label: 'Sair', description: `${findings.length} achado(s); verificado ${live ? 'agora' : `há ${age} min`}` });
    const picked = await context.ui.select('Roster — achados são propostas, nada muda sozinho', options);
    if (!picked || picked === 'Sair') return;

    const finding = findings.find(f => picked.includes(f.model));
    if (!finding) return;
    const bareId = finding.model.split('/').pop()!;

    if (finding.kind === 'stale') {
      context.ui.notify(`${finding.model}: ${finding.detail}. Remova de MODELS/QUALIFICATIONS em policy.ts — é uma decisão revisada, não automática.`, 'warning');
      continue;
    }
    if (finding.kind === 'repriced') {
      context.ui.notify(`${finding.model}: ${finding.detail}. Reveja a classe de custo em policy.ts se a mudança altera a ordem.`, 'warning');
      continue;
    }

    // Candidate: probe, then optionally flip the routing gate.
    const wire = context.wireRefFor(bareId);
    if (!wire) {
      context.ui.notify(`${finding.model} não está no catálogo do 9Router; não há rota para testar.`, 'warning');
      continue;
    }
    if (!context.gateway) {
      context.ui.notify('Sem credencial do gateway nesta sessão; não posso sondar.', 'warning');
      continue;
    }
    const existing = probed.get(finding.model);
    const action = await context.ui.select(`${finding.model}`, [
      { label: existing ? 'Sondar de novo' : 'Sondar agora', description: '5 chamadas reais: instrução, tool round-trip completo, reasoning, contexto longo, effort hint' },
      ...(existing?.suggests.goValidated ? [{ label: 'Validar para tool-loop', description: `escreve goValidated += ${bareId} em settings.json` }] : []),
      { label: 'Voltar', description: finding.detail },
    ]);
    if (!action || action === 'Voltar') continue;

    if (action.startsWith('Sondar')) {
      context.ui.notify(`Sondando ${wire}…`);
      const result = await probeModel({ baseUrl: context.gateway.baseUrl, apiKey: context.gateway.apiKey, wireModel: wire });
      probed.set(finding.model, result);
      context.log('roster-probe', { model: wire, routable: result.routable, qualification: result.qualification, checks: result.checks.map(c => ({ check: c.check, pass: c.pass, ms: c.elapsedMs })) });
      const lines = result.checks.map(c => `${c.pass ? '✓' : '✗'} ${c.check} (${c.elapsedMs}ms): ${c.detail}`).join('\n');
      const hint = result.acceptsEffortHint ? '' : '\nAtenção: o upstream rejeita reasoning_effort; o router não deve enviá-lo para este modelo.';
      const band = result.qualification.validatedContextTokens ? `\nContexto validado: ~${result.qualification.validatedContextTokens / 1000}k (a janela anunciada continua não comprovada).` : '';
      context.ui.notify(`${wire}\n${lines}${hint}${band}\n\n${result.routable ? 'Passou em tudo.' : result.suggests.goValidated ? 'Tools e reasoning OK; elegível para tool-loop.' : 'Não elegível para tool-loop.'}`, result.routable || result.suggests.goValidated ? 'info' : 'warning');
      continue;
    }

    if (action.startsWith('Validar')) {
      const result = probed.get(finding.model);
      if (!result?.suggests.goValidated) { context.ui.notify('Sonde primeiro: validação exige tools e reasoning aprovados.', 'warning'); continue; }
      const sure = await context.ui.confirm('Validar modelo', `Escrever goValidated += ${bareId}?\n\nIsso só libera o guard de tool-loop. A qualificação por tier continua sendo decisão sua em policy.ts.`);
      if (!sure) continue;
      const written = addGoValidated(context.root, bareId, result.qualification);
      context.log('roster-validate', { model: bareId, ok: written.ok, detail: written.detail });
      context.ui.notify(written.ok ? `${written.detail}. Vale na próxima sessão.` : written.detail, written.ok ? 'info' : 'error');
    }
  }
}
