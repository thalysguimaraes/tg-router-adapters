// 9Router as a plain OMP model provider: registers `9router/*` from the reviewed
// catalog and nothing else. No `router/router` model, no routing hooks, no /route.
// Load this file instead of `index.ts` when auto-routing is not wanted.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { streamSimple } from '@oh-my-pi/pi-ai';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types';
import { installNineRouter as installNineRouterBundle } from './ninerouter';
import type { NineRouterController } from './ninerouter-types';

// Generated bundle ships untyped; ninerouter-types.ts is its contract.
const installNineRouter = installNineRouterBundle as unknown as (pi: ExtensionAPI, options: { root: string; nativeStreamSimple: typeof streamSimple; log: (event: string, data?: object) => void }) => NineRouterController;

export default function nineRouterProvider(pi: ExtensionAPI) {
  const root = process.env.OMP_PERSONAL_ROUTER_HOME ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'), 'personal-router');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const log = (event: string, data: object = {}) => {
    try { appendFileSync(join(root, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', { mode: 0o600 }); } catch {}
  };
  const nineRouter = installNineRouter(pi, { root, nativeStreamSimple: streamSimple, log });
  // OMP's builtin `/fast` keys off the provider family; `9router/*` is a custom api
  // with none, so toggle the OpenAI tier here for `cx/` models.
  // ponytail: OpenAI only. Gateway Claude rejects `speed: fast` without usage credits.
  pi.on('input', (event, ctx) => {
    const match = /^\/fast(?:\s+(\S+))?$/i.exec(event.text.trim());
    const m = ctx.model;
    if (!match || m?.provider !== nineRouter.provider || !m.id.startsWith('cx/')) return;
    const arg = (match[1] ?? 'toggle').toLowerCase();
    const on = pi.getServiceTiers().openai === 'priority';
    if (arg === 'status') { ctx.ui.notify(`Fast mode is ${on ? 'on' : 'off'} (OpenAI routes).`); return { handled: true }; }
    const next = arg === 'on' ? true : arg === 'off' ? false : arg === 'toggle' ? !on : undefined;
    if (next === undefined) { ctx.ui.notify('Usage: /fast [on|off|status]', 'warning'); return { handled: true }; }
    pi.setServiceTier('openai', next ? 'priority' : undefined);
    ctx.ui.notify(`Fast mode ${next ? 'enabled' : 'disabled'} (OpenAI routes).`);
    return { handled: true };
  });
}
