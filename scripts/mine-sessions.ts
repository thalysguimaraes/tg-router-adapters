// Mine omp sessions into a labeled routing corpus.
//
// One row per substantive user turn, describing the WHOLE task attempt, not
// just the model that happened to answer last: every model that worked on it,
// total tool calls, error turns, whether a model change was an automatic
// fallback or a manual switch, and the text of the next user turn (the only
// acceptance evidence a session actually contains). `scripts/relabel.ts` turns
// those into outcome labels; nothing here decides an outcome.
import { readdirSync, statSync, createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { redactAndClip } from '../core/routing-context';
import { homedir } from 'node:os';

// Same resolution the extension uses, so a scratch run can be pointed elsewhere.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent');
const ROOT = join(AGENT_DIR, 'sessions');
const files = [];
for (const dir of readdirSync(ROOT)) {
  const p = join(ROOT, dir);
  let st; try { st = statSync(p); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const f of readdirSync(p)) if (f.endsWith('.jsonl')) files.push(join(p, f));
}

const CONTINUE = /^(continue|continuar|continua|prossiga|prosseguir|siga|segue|sim|ok|okay|certo|pode seguir|pode continuar|vai em frente|go ahead|proceed|resume|keep going|do it|yes|yep|yeah|go|go, go, go)[.!?\s]*$/i;
const text = (content) => Array.isArray(content) ? content.filter(c => c?.type === 'text').map(c => c.text ?? '').join('\n') : typeof content === 'string' ? content : '';
const canonical = (m) => (m ?? '').replace(/^9router\/(cc|cx|ocg)\//, (_, p) => ({ cc: 'anthropic/', cx: 'openai-codex/', ocg: 'opencode-go/' })[p]).replace(/^anthropic\/anthropic\//, 'anthropic/');

const rows = [];
let sessions = 0, skippedSmall = 0;
for (const file of files) {
  const st = statSync(file);
  if (st.size < 2000) { skippedSmall++; continue; }
  sessions++;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let header = {};
  let currentModel;
  let pendingUser;            // {prompt, at, model}
  let assistantAfter = 0, toolCalls = 0, lastStop, lastModel, errorTurns = 0;
  let modelChangeSinceUser = false, automaticFallbackSinceUser = false;
  let modelsUsed = new Set();
  const flush = (nextUserText) => {
    if (!pendingUser) return;
    rows.push({
      session: header.id, cwd: header.cwd ? basename(header.cwd) : undefined, child: !!header.parentSession, modelRole: header.modelRole ?? null,
      at: pendingUser.at, prompt: pendingUser.prompt, promptLen: pendingUser.promptLen,
      modelAtPrompt: canonical(pendingUser.model), modelAnswered: canonical(lastModel),
      // The whole trajectory: recovery by a dearer model belongs to this task.
      modelsUsed: [...modelsUsed].map(canonical),
      assistantTurns: assistantAfter, toolCalls, errorTurns, lastStop,
      userSwitchedModelAfter: modelChangeSinceUser && !automaticFallbackSinceUser,
      automaticFallbackAfter: automaticFallbackSinceUser,
      // Redacted first 400 chars of the following user turn: the only in-session
      // evidence of whether the work was accepted or sent back.
      nextUserText: nextUserText ? redactAndClip(nextUserText, 400).text : undefined,
      continuation: CONTINUE.test(pendingUser.prompt.trim()),
    });
    pendingUser = undefined; assistantAfter = 0; toolCalls = 0; errorTurns = 0; lastStop = undefined;
    modelChangeSinceUser = false; automaticFallbackSinceUser = false; modelsUsed = new Set();
  };
  for await (const line of rl) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'session') { header = e; continue; }
    if (e.type === 'model_change') {
      if (pendingUser && assistantAfter > 0) {
        modelChangeSinceUser = true;
        // A fallback is the router/host recovering, not the user rejecting the work.
        if (e.resolvedModelIsFallback === true) automaticFallbackSinceUser = true;
      }
      currentModel = e.model;
      continue;
    }
    if (e.type !== 'message') continue;
    const m = e.message; if (!m) continue;
    if (m.role === 'user') {
      const t = text(m.content).trim();
      if (!t || t.startsWith('/')) continue;
      flush(t);
      pendingUser = { prompt: redactAndClip(t, 4000).text, promptLen: t.length, at: e.timestamp, model: currentModel };
    } else if (m.role === 'assistant') {
      assistantAfter++;
      lastModel = m.provider && m.model ? `${m.provider}/${m.model}` : currentModel;
      if (lastModel) modelsUsed.add(lastModel);
      lastStop = m.stopReason;
      if (m.stopReason === 'error') errorTurns++;
      if (Array.isArray(m.content)) toolCalls += m.content.filter(c => c?.type === 'toolCall' || c?.type === 'tool_use').length;
    }
  }
  flush();
}
const out = join(AGENT_DIR, 'personal-router', 'session-corpus.jsonl');
mkdirSync(join(AGENT_DIR, 'personal-router'), { recursive: true, mode: 0o700 });
writeFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
console.log(JSON.stringify({ files: files.length, sessions, skippedSmall, rows: rows.length, out }));
