import { describe, expect, test } from 'bun:test';
import { analyzeRoster, parseModelsDev, parseOpenRouter } from './roster-monitor';

const NOW = Date.UTC(2026, 8, 18);
const days = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);

describe('roster monitor', () => {
  test('a roster model that vanished from its provider is reported stale (the Union case)', () => {
    // opencode-go once served union-alpha for free; it no longer exists there.
    const findings = analyzeRoster({
      roster: ['opencode-go/union-alpha', 'opencode-go/glm-5.3-flash'],
      modelsDev: [{ id: 'glm-5.3-flash', provider: 'opencode-go', inputPerMtok: 0.15, outputPerMtok: 0.5, context: 1_000_000 }],
      openrouter: [],
      now: NOW,
    });
    expect(findings.map(f => f.kind + ':' + f.model)).toEqual(['stale:opencode-go/union-alpha']);
  });

  test('a free model at a subscribed provider is a candidate regardless of age', () => {
    const findings = analyzeRoster({
      roster: ['opencode-go/glm-5.3-flash'],
      modelsDev: [
        { id: 'glm-5.3-flash', provider: 'opencode-go', inputPerMtok: 0.15, outputPerMtok: 0.5, context: 1_000_000 },
        { id: 'ox-alpha-free', provider: 'opencode-go', inputPerMtok: 0, outputPerMtok: 0, context: 1_000_000, releaseDate: days(400) },
      ],
      openrouter: [], now: NOW,
    });
    expect(findings.some(f => f.kind === 'candidate' && f.model === 'opencode-go/ox-alpha-free' && /FREE/.test(f.detail))).toBe(true);
  });

  test('paid candidates must be recent and have enough context; unsubscribed providers are ignored', () => {
    const findings = analyzeRoster({
      roster: [],
      modelsDev: [
        { id: 'old', provider: 'opencode-go', inputPerMtok: 1, outputPerMtok: 1, context: 1_000_000, releaseDate: days(200) },
        { id: 'small', provider: 'opencode-go', inputPerMtok: 1, outputPerMtok: 1, context: 8_000, releaseDate: days(1) },
        { id: 'elsewhere', provider: 'some-other-lab', inputPerMtok: 0, outputPerMtok: 0, context: 1_000_000, releaseDate: days(1) },
        { id: 'good', provider: 'opencode-go', inputPerMtok: 1, outputPerMtok: 1, context: 1_000_000, releaseDate: days(10) },
      ],
      openrouter: [], now: NOW,
    });
    expect(findings.map(f => f.model)).toEqual(['opencode-go/good']);
  });

  test('a price move of at least 25% is reported; smaller moves are not', () => {
    const findings = analyzeRoster({
      roster: ['opencode-go/glm-5.3-flash', 'opencode-go/deepseek-v4.1-flash'],
      modelsDev: [
        { id: 'glm-5.3-flash', provider: 'opencode-go', inputPerMtok: 0.30, outputPerMtok: 0.5, context: 1_000_000 },
        { id: 'deepseek-v4.1-flash', provider: 'opencode-go', inputPerMtok: 0.16, outputPerMtok: 0.6, context: 1_000_000 },
      ],
      openrouter: [],
      previousPrices: { 'opencode-go/glm-5.3-flash': 0.15, 'opencode-go/deepseek-v4.1-flash': 0.15 },
      now: NOW,
    });
    expect(findings.filter(f => f.kind === 'repriced').map(f => f.model)).toEqual(['opencode-go/glm-5.3-flash']);
  });

  test('finding ids are deterministic so a cron only reports what is new', () => {
    const run = () => analyzeRoster({ roster: ['opencode-go/gone'], modelsDev: [], openrouter: [], now: NOW });
    expect(run().map(f => f.id)).toEqual(run().map(f => f.id));
  });

  test('parsers tolerate malformed catalogs without throwing', () => {
    expect(parseModelsDev(null)).toEqual([]);
    expect(parseModelsDev({ p: { models: { x: { cost: 'nope' } } } })).toEqual([{ id: 'x', provider: 'p' }]);
    expect(parseOpenRouter({ data: 'nope' })).toEqual([]);
    expect(parseOpenRouter({ data: [{ id: 'a/b', pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 10 }] }))
      .toEqual([{ id: 'a/b', provider: 'openrouter', inputPerMtok: 1, outputPerMtok: 2, context: 10 }]);
  });
});
