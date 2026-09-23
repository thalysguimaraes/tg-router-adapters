<div align="center">

<img src="assets/logo.png" alt="tg-router" width="120">

# tg-router-adapters

**Quota-aware model routing for [Oh My Pi](https://github.com/oh-my-pi).**
Picks which model answers each turn across every subscription and paid
endpoint you own, so the whole pool gets used instead of one favourite model
getting drained.

[Why](#why) · [How a turn is routed](#how-a-turn-is-routed) · [Install](#install) · [Configuration](#configuration) · [Commands](#commands) · [Evidence](#evidence)

</div>

---

## Why

If you hold several AI subscriptions, the default behaviour of most tooling is
to pick one model and use it until its window is empty. Everything else sits
idle, then the one you exhausted is the one you needed.

tg-router makes that a routing problem. Each turn gets a **capability floor**
from the task, not a model name. The pool then answers a different question:
which qualified route is cheapest right now, given live quota, in-flight work
by sibling agents, and money already committed? A premium model with slack is
not a reason to spend premium.

It is opinionated and evidence-driven. Every rule in the classifier is backed
by a measurement against a corpus of real sessions, and anything that could
silently pick a *worse* model is off until it can be proven on a frozen
holdout. See [Evidence](#evidence).

> **Personal project, published as a reference.** This is the author's daily
> router, not a product. It assumes a self-hosted
> [9Router](https://github.com/9router) gateway, specific subscriptions, and
> macOS. Read [Install](#install) before expecting it to work as-is; the
> routing policy in `policy.ts` is a reviewed personal roster you are meant to
> replace with your own.

The router has exactly two user-facing states:

- **auto** — rules decide the capability floor; Jev (TypeSafe's System One
  model) refines it when a key is present; quota and money pick the cheapest
  qualified route. The status line always shows which one decided:
  `route auto · jev · astra` or `route auto · rules · astra`.
- **pin** — your model, no classification, no spend.

## How a turn is routed

```
user turn / child spawn / handoff
        │
        ▼
 task episode     ──►  goal + phase + decision epoch. A short follow-up keeps
                       the episode; a new substantive request replaces the goal
                       and opens a new epoch.
        │
        ▼
 rules classifier  ──►  capability floor (mechanical … premium) + phase, for
                       THIS request (`classifyTask`)
        │
        ▼
 Jev (optional)    ──►  phase clarification, floor raise. Never lowers. The
                       resolved classification is passed explicitly to
                       allocation (`RouteInput.classification`).
        │
        ▼
 admission         ──►  authenticated, context fits, tools/images, Go validation,
                        known-exhausted windows, paid-fallback authorization
        │
        ▼
 allocation        ──►  cheapest eligible cost class, then the shortlist within
                        PRESSURE_SWAP_RATIO of that class's max post-request
                        usable headroom (fresh capacity minus in-flight work on
                        the same shared window), then forecast task cost inside
                        the paid class, then reviewed preference. Reordering
                        candidates cannot change the winner.
        │
        ▼
 exact model + effort + transport (9Router / native / guarded OpenRouter)
        │
        ▼
 per-attempt admission ──►  every provider request, tool-loop continuations
                        included, is re-checked against the route it will use
                        (`admitAttempt`). The DECISION is frozen (route, committed
                        tier, capability snapshots); the FACTS are rebuilt per
                        attempt: current context size, latest local gateway
                        usage, current clock. A pin chooses the route but is
                        still checked against those facts; only the
                        committed-tier floor is automatic-mode only. No
                        reclassification, no spend.
```

### Terminal vs transient failure

A failure only refuses the next attempt when retrying genuinely cannot help.
The two cases are kept apart deliberately, because conflating them is how a
router strands a session:

| | example | lifetime | effect |
|---|---|---|---|
| **terminal** | 9Router wraps an upstream `401 Model <id> is not supported` in a retryable `503` | 24h | route blocked, a pin pointing at it released, next attempt refused instead of retried |
| **transient** | timeout, dropped connection, genuine `5xx` | 3min | steers the *next* routing decision away; never refuses an attempt |

Terminal failures are recognized from `auto_retry_start` as well, because
retries emit no `message_end` — otherwise the host spends its whole retry
budget on a permanent condition. A transient failure must never be able to
refuse an attempt: the route it would block may be the only one the session
has, and "the network blipped" is not evidence the route is wrong.

Classification happens only at a safe boundary: a new user task, a spawned
child, an explicit handoff, or a provider failure. Never mid tool-loop.
Session state is committed only after the route was actually applied.

## Principles

- **Floor, not pick.** The task sets the minimum capability. The pool decides
  which qualified model. Allocation is lexicographic: cost class first (worker
  < mid < premium < paid), then headroom within the class, then a reviewed
  preference order. A premium model is never given work a cheaper qualified
  model can do; premium slack is not a reason to spend premium.
- **Accounts are alternatives, windows are not.** Two Claude subscriptions are
  compared, never summed and never intersected. But two models of the *same*
  subscription share its meter: Fable and Sonnet both resolve `weekly-7d` to one
  allowance, so spending one spends the other. Windows carry a `sharedKey`
  (`provider:accountHash:windowId`), and headroom is ranked **after** debiting
  work other live agents already committed against that key — otherwise N
  concurrent agents each count the same slack as theirs. Absent key means "not
  known to be shared", never "known independent".
- **Money is compared, not just capped.** Paid routes share one cost class and
  have no quota window, so inside that class the cheaper *forecast for this
  task* wins before the reviewed preference order; an unpriced route never
  outranks a priced one. The forecast is the same conservative bound the ledger
  reserves against, so the price compared is the price admission demands. Hard
  daily/monthly caps still gate everything, and `/route status` reports
  forecast-vs-realized drift over settled requests.
- **Fail closed, stay visible.** Missing key, timeout, budget, malformed
  answer: the classifier steps aside, rules continue, the status line says
  `rules`. Nothing optional may ever break extension load.
- **Every paid call settles.** A classifier reservation returns a handle:
  reserve, mark dispatched, settle from the response's reported
  `usage.input_tokens`. Billing validation is independent of answer validation,
  so an unusable assessment with valid usage still settles. A timeout keeps its
  liability; nothing releases a request that may have reached the server.
- **Pinned classifier version.** `jev-1.13.0`, not the `jev-latest` alias: the
  gates were tuned against a specific answer distribution, and an alias can
  move under them. New versions are evaluated in shadow first.
- **Stale telemetry is unknown, not empty and not exhausted.** A failed refresh
  keeps unexpired exhaustion and model locks, and never replenishes capacity.
  Only fresh, unreset observations supply positive headroom.
- **Secrets never touch settings or history.** The TypeSafe key is read from
  1Password into omp's own credential store by `/route key`. It is never a
  command argument, because omp persists slash commands to `history.db`.

## Commands

| Command | Effect |
|---|---|
| `/route` | status JSON |
| `/route auto` | automatic routing (rules + Jev if keyed) |
| `/route off` | manual; keep whatever model is selected |
| `/route pin <provider/model>` | fix a model for this session |
| `/route key` | import the TypeSafe key from 1Password (`AgentKit - Typesafe`) into omp's credential store. `status` / `clear` |
| `/route why` | one deterministic sentence explaining the last decision |
| `/route feedback fail\|success` | record a quality outcome; two failures escalate the tier |
| `/route handoff` | mark work state safe to leave the current model/family |
| `/route high-value` | allow spending soft reserves; disables headroom swaps |
| `/route roster` | review catalog findings, probe candidates, vet them |
| `/route usage` / `refresh` / `reconcile` | 9Router telemetry and paid-ledger reconciliation |

## Install

**Requirements**

| | |
|---|---|
| [Bun](https://bun.sh) | 1.3+ |
| [Oh My Pi](https://github.com/oh-my-pi) | the host agent; this is an extension, not a standalone tool |
| A [9Router](https://github.com/9router) deployment | *optional but assumed*: the gateway fork of 9router that multiplexes subscription accounts and performs quota-aware account selection. Without it only native and OpenRouter transports work. |
| A TypeSafe key | *optional*: enables Jev-assisted classification. Without it the router runs on rules alone and says so. |
| macOS | only for the launchd roster schedule; everything else is portable. |

```sh
git clone https://github.com/thalysguimaraes/tg-router-adapters.git
cd tg-router-adapters
bun install
bun run link        # symlinks this checkout into ~/.omp/agent/extensions/personal-router
```

omp follows symlinked extension directories, so the checkout is live: edits
apply on the next omp session. Runtime state (ledger, quota cache, decision
log, session corpus) lives in `~/.omp/agent/personal-router/`, never in this
repo. `PI_CODING_AGENT_DIR` overrides the agent directory.

**Before it routes anything for you**, edit `policy.ts`: `MODELS`, the roster
in `REFS`/`BACKUPS` (`omp/index.ts`), and `QUALIFICATIONS` encode which models the
author reviewed and trusts for which tier. They are a personal decision, not a
benchmark. Catalog presence is never qualification.

### Configuration

Environment — deployment facts, no personal defaults shipped:

| Variable | Default | Effect |
|---|---|---|
| `OMP_NINEROUTER_ORIGIN` | from `gateway.baseUrl` | overrides the 9Router origin. Normally unset: the origin is read from `settings.json`, where the transport already needs it. Must be `https`; resolved once at install and then fixed, so a caller cannot redirect credentials mid-flight. With neither configured the gateway stays disabled rather than guessing a host. |
| `OMP_NINEROUTER_OP_REF` | `op://Personal/9Router/password` | 1Password reference for the gateway admin password. |
| `OMP_ROUTER_TYPESAFE_OP_REF` | `op://Personal/AgentKit - Typesafe/password` | 1Password reference for the TypeSafe key used by `/route key`. |
| `TYPESAFE_API_KEY` | — | supplies the key directly, bypassing 1Password. |
| `PI_CODING_AGENT_DIR` | `~/.omp/agent` | agent home used by `bun run link` and runtime state. |

`~/.omp/agent/personal-router/settings.json` — behaviour:

| Key | Default | Effect |
|---|---|---|
| `enabled` | `true` | `false` disables routing entirely; omp keeps whatever model is selected. |
| `gateway` | — | 9Router transport config. `gateway.enabled` toggles it; `gateway.baseUrl` is your gateway's `/v1` endpoint and is also where the admin origin comes from. |
| `paidFallbackEnabled` | `false` | allows falling back to paid OpenRouter routes when no subscription route qualifies. Every paid call still needs a reserved budget. |
| `dailyCashCapUsd` | `10` | hard daily ceiling for paid spend. |
| `monthlyCashCapUsd` | `30` | hard monthly ceiling. |
| `openrouterPriceCeilings` | — | per-model price ceilings used for the conservative cost bound. |
| `claudeAccountOwner` | `omp-native` | `meridian` routes Anthropic through Meridian profiles instead of omp's OAuth store. |
| `goValidated` | `[]` | OpenCode Go model ids cleared for tool use. Written by `/route roster`. |
| `goVisionValidated` | `[]` | same, for image input. |
| `goQualifications` | `{}` | the evidence behind each entry: probed model, transport, fixture version, tool round trip. Routing reads this, not the bare list. |
| `goLegacyValidated` | `false` | accept `goValidated` entries that have no qualification record. Off by default: an old boolean is not current evidence. |
| `semanticRouter.mode` | `assisted` | `off` disables Jev; `shadow` computes a real assisted proposal and records it without executing it; `calibrated` additionally requires `acknowledgeUncalibratedDowngrades: true` and is unreachable from the user surface. |

The TypeSafe key is never a settings value and never a command argument — omp
persists slash commands to `history.db`. `/route key` reads 1Password and
writes into omp's own credential store.

## Verify

```sh
bun test            # 149 tests: policy, quota, ledger, classifier contract, pipeline, admission hooks, probe, load safety
bun run typecheck   # strict, every owned module including index.ts
```

## Layout

| File | Owns |
|---|---|
| `omp/index.ts` | OMP extension entrypoint: hooks, session state, commands, per-attempt admission |
| `core/policy.ts` | pure routing policy: `classifyTask`, `resolveClassification`, `admitAttempt`, allocation |
| `core/episode.ts` | task episodes: goal, phase, decision epoch |
| `omp/ninerouter-types.ts` | hand-owned contract for the generated transport bundle |
| `core/jev-questions.ts` | the seven typed questions sent to Jev; the only place rubric text lives |
| `core/jev-client.ts` | dependency-free native TypeSafe client; one attempt, hard deadline, strict validation |
| `core/routing-context.ts` | bounded, redacted task state; HMAC cache keys |
| `core/assessment-cache.ts` | TTL + single-flight, bounded-eviction cache of assessments |
| `core/budget.ts` | atomic cash ledger with purpose sub-caps |
| `core/roster-monitor.ts` | catalog comparison; emits proposals, never edits |
| `core/roster-probe.ts` | capability probe; five real calls, stops before harming a provider |
| `omp/roster-ui.ts` | `/route roster` review screen: findings, probe, vet |
| `core/ninerouter-usage.ts` | 9Router telemetry, per-account windows, exhaustion tombstones |
| `core/quota.ts` / `core/meridian.ts` | native and Meridian quota adapters |
| `core/guarded-openrouter.ts` | paid transport guard; rejects unbudgeted calls |
| `omp/ninerouter.ts` | **generated bundle** of the 9Router transport + model catalog; do not hand-edit. It carries `@ts-nocheck` (emitted without annotations) and is excluded from `tsconfig.json`; the surface the router depends on is typed in `omp/ninerouter-types.ts`, so drift after regeneration fails the typecheck at the call sites. |

## Evidence

Every routing rule below was measured, not guessed. The measurements come from
the author's own sessions and the corpus never leaves the machine.

### Data

`~/.omp/agent/personal-router/session-corpus.jsonl` is a redacted extract of
real omp sessions: one row per substantive user turn, describing the whole task
attempt (prompt, every model that worked on it, tool calls, error turns, whether
a model change was a manual switch or an automatic fallback, and the next user
turn's text). Regenerated by `scripts/mine-sessions.ts`, labelled by
`scripts/relabel.ts`. Gitignored and never published; every text field passes
through the same redact-then-clip pipeline the live classifier uses
(`routing-context.ts`), so credentials and home paths are removed before the
text is stored or sent anywhere.

### Verified outcomes, not model choices and not effort

"You used a cheap model here" is not evidence that cheap was enough: in the
corpus cheap models did the same work worse (2x tool calls, 3x error turns).
Neither is "it did not crash", and neither is tool-call volume — effort is not
correctness. Labels are therefore evidence-backed and mutually exclusive:

| label | evidence |
|---|---|
| `accepted` | finished (`stop`) and the next user turn accepts it or moves on. The strongest in-session acceptance evidence that exists. |
| `quality-failed` | finished, but the next user turn sends it back, or the user manually switched model right after. Attributable to the generated work. |
| `infra-failed` | an error turn or an automatic fallback. Never trains model quality. |
| `interrupted` | aborted, truncated, still in a tool loop, no terminal state, or the last turn of a session. Not a success and not a failure. |

`effort` (tool calls, assistant turns, models used) rides alongside and is never
substituted for the outcome. Measured on 2,861 turns: 1,489 accepted, 913
interrupted, 178 infra-failed, 168 quality-failed.

Calibration classes come from those labels, not from model choice:
`cheapSufficient` is an accepted cheap attempt that no dearer model touched;
`premiumWarranted` is a cheap attempt that quality-failed or that a dearer model
had to finish. Turns are split by **session and time**, never at random, so
related continuations cannot straddle the boundary and the holdout is strictly
later than the tuning set. Gate sweeps run on the tuning set only; the holdout
is scored once, at the chosen gate. The invariant that gates shipping:
**0 false downgrades on the frozen holdout**.

### Session signals

Two measured signals are computed from the session at decision time and act
as deterministic downgrade guards, independent of anything Jev says:

| signal | measured struggle rate | effect |
|---|---|---|
| previous assistant turn errored | 15% vs 4% after a clean turn | blocks downgrade |
| first user turn of a session | 25% vs ~4% later | blocks downgrade |

They are also sent to Jev as structured `observations` fields, never as prose.
The previous turn's tool-call count is carried for traces; on its own it did
not separate outcomes.

### Rules derived from the corpus

The old classifier sent 69% of turns to `complex` through its no-keyword
default. Two rules now fire before that default, each backed by a measurement:

- **Session/repository operations** (deploy, commit, push, merge, reconcile,
  close the worktree, move the issue) are `bounded`. Among no-keyword prompts
  these had the highest cheap-clean share (20% vs 13% base) and a below-base
  cheap-struggled share (5% vs 8%). Verbs only: a delegation brief that merely
  says "work in this worktree" is excluded — the replay caught five of those
  being pushed down.
- **Pasted stack traces / code blocks** are `complex` investigation. 14% of
  cheap-struggled turns carried pasted code against 1% of cheap-clean. This is
  the strongest under-routing signal in the corpus.
- **Delegation briefs** (>=80 words plus two headings, goal/acceptance
  scaffolding, or embedded tags) floor at `execution`. Measured over the 381
  turns where a cheap model was actually tried: briefs finished cleanly 31% of
  the time against 69% for everything else, with p50 69 tool calls against 14.

  Structure beats vocabulary. This rule resolved a real anomaly: `mechanical`
  keywords looked *unsafe* (39% cheap success, second worst of every feature
  measured) purely because a 200-line spec containing the word "list" was
  being classified as a listing task. Excluding briefs takes mechanical's
  cheap success to 53%, and a brief is never mechanical however it reads.

Replay on 1,799 labelled turns: 18 cheap-clean and 63 premium-clean moved
down (median 10 tool calls — light work), **0 cheap-struggled moved down**.

## Roster monitor

The reviewed roster lives in `policy.ts` and only a human changes it. A
scheduled check compares it against structured catalogs (models.dev and
OpenRouter's pricing API, not scraped HTML) and prints proposals:

- **stale** — a roster model no longer exists at its provider (this is how
  Union would have been caught when its free window closed)
- **repriced** — a paid price moved by 25% or more
- **candidate** — a free model at a provider you already subscribe to, or a
  recent one with enough context

```sh
bun run roster-check          # new findings since last run
bun run roster-check --all    # everything current
```

### Vetting a candidate

Reading a catalog row does not tell you whether a model survives a tool loop,
so `/route roster` inside omp turns a finding into evidence. It lists findings,
probes a candidate on demand with five real gateway calls, prints per-check
results, and only then offers to write the `goValidated` entry that makes a Go
model routable for tool work.

| Check | Gate it earns |
|---|---|
| `instruction` | follows an exact-output instruction |
| `tools` | full round trip: emits a well-formed call, receives a synthetic tool result, and cites that result in its answer — `validated.tools` |
| `reasoning` | solves a trick arithmetic prompt — `validated.reasoning` |
| `longContext` | finds a needle at ~32k tokens; proves that band is usable |
| `effortHint` | informational: whether the upstream accepts `reasoning_effort` |

`tools` is a genuine round trip because emitting a call only proves the request
shape, while every turn after the first depends on the model consuming the
result. The synthetic result carries a temperature the model cannot guess, so a
grounded answer is provable rather than plausible.

Validating writes a `goQualifications` record beside the `goValidated` entry:
probed model id, the versioned id the gateway reported answering, transport,
fixture version, effort-hint support, the context band actually exercised and
the provider-reported `measuredInputTokens` of that check. One needle at 32k
does not certify a 200k window and one arithmetic item is not a reasoning
benchmark, so the record states exactly what was tested. The second tool turn
replays the provider's own returned assistant message (its call id and any
extra fields), not a fabricated one.

Routing consumes the record, not the bare boolean: a Go model is tool-eligible
only when `goValidated` lists it AND its record is about the same wire model,
the current transport, the current `PROBE_FIXTURE_VERSION`, and passed the
tool round trip. Bumping a check bumps `PROBE_FIXTURE_VERSION`, which makes
older evidence stale and therefore ineligible until requalified. A `goValidated`
entry with no record is legacy evidence and counts only with
`"goLegacyValidated": true` in settings.

Two rules the probe learned the hard way, both now regression-tested:

- **It stops on the first account-level error.** Probing a model the gateway
  does not serve makes the upstream reject the whole account, and 9Router then
  401s every model on it for a cooldown. Candidates are filtered to what the
  9Router catalog actually serves, and any auth or rejected-body response ends
  the run instead of degrading a live provider.
- **It never measures its own request shape.** `reasoning_effort` is sent only
  in the informational check, because a Go upstream 400s on it; and every check
  allows 512 completion tokens, because reasoning models emit
  `reasoning_content` first and a tight budget truncates the real answer to
  empty. A truncated response reports `inconclusive`, not a failure.

Catalog presence is never qualification. Tier qualification stays a reviewed
decision in `policy.ts`; the probe only unlocks the transport-level gate.

`scripts/roster-check.plist.template` runs it every 48h via launchd; the file
header has the two-line `sed` that fills in your bun, repo and log paths.
Findings and price history live in `~/.omp/agent/personal-router/`. It never
edits policy.

## Calibration result: no semantic downgrades

`bun run calibrate` scores two verified-outcome classes from
`session-corpus.jsonl` against the pinned classifier: accepted cheap attempts
(`cheapSufficient`) and cheap attempts that quality-failed or needed a dearer
model to finish (`premiumWarranted`).

Run on 2026-09-18, under the old model-choice classes and over 160 turns, **Jev
did not separate them**. 41% of premium-warranted turns were judged `bounded`;
63% of cheap-sufficient turns were judged `execution` or higher. No confidence
or probability-mass threshold admitted meaningful cheap work — fully open it
still admitted 5 of 80.

That verdict has not been re-run against the verified labels, and the current
corpus does not support one: it yields 96 `cheapSufficient` and only 11
`premiumWarranted` turns, and the script warns below 20 per tuning class. Any
separation measured at that size would be noise. Downgrades stay off on the
earlier evidence, not on a fresh measurement.

The cause is visible in the prompts and is not a model defect: real turns are
conversational continuations whose difficulty lives in the accumulated session,
not the sentence ("align the text of the right block to the right"). Jev reads
the text correctly; the text understates the work.

So downgrades stay off. `calibrated` mode is unreachable from the user surface
and, even in settings, requires
`semanticRouter.acknowledgeUncalibratedDowngrades: true`. Jev's demonstrated
value is phase clarification and resolving short follow-ups against a
persistent task goal — both of which only raise or clarify.

The 69%-of-turns-are-`complex` problem is the deterministic classifier's, and
is fixable there with the same corpus.

## Not yet

- Money is not yet a window in the allocator: paid routes are a lower cost
  class, but their remaining daily cap does not contribute headroom.
- Jev's tier is used as a floor raise only.
- The no-keyword default still lands on `complex` when there is no prior
  phase. More corpus-backed rules can chip at it; each must pass the
  0-struggled-moved-down replay.
- Structured session signals reach Jev but move its answers only slightly
  (reasoning depth 1.9 → 2.4 as difficulty stacks). Their real value is in
  the deterministic guard, not the classifier.

## License

MIT. See [LICENSE](LICENSE).
