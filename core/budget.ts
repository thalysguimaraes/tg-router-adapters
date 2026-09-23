import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MICRO_USD = 1_000_000;
export interface BudgetLimits { dailyCapUsd?: number; monthlyCapUsd?: number }
/** A purpose is a spend category inside the same global caps, with its own optional subcaps. */
export type BudgetPurpose = "execution" | "classifier";
export interface BudgetSubcaps { dailyCapUsd?: number; monthlyCapUsd?: number }
export interface BudgetSnapshot {
  timezone: "UTC";
  dailyCapUsd: number;
  monthlyCapUsd: number;
  dailySpentUsd: number;
  monthlySpentUsd: number;
  pendingUsd: number;
  pendingCount: number;
  dailyCommittedUsd: number;
  monthlyCommittedUsd: number;
  dailyRemainingUsd: number;
  monthlyRemainingUsd: number;
  /**
   * How conservative the reservation bound has actually been, over settled
   * requests. A bound far above realized spend blocks affordable work through
   * the caps; measured drift is the evidence for changing it, and is not a
   * licence to reserve optimistically.
   */
  forecast?: { settledCount: number; forecastUsd: number; realizedUsd: number; ratio: number };
}
export type ReserveResult =
  | { ok: true; idempotent: boolean; status: "reserved" | "dispatched"; estimatedUsd: number; snapshot: BudgetSnapshot }
  | { ok: false; reason: "daily-cap" | "monthly-cap" | "request-finalized"; snapshot: BudgetSnapshot };
export interface Settlement { idempotent: boolean; actualUsd: number; estimateUsd: number; overEstimateUsd: number }
interface Row {
  request_id: string;
  estimated_micro: number;
  actual_micro: number | null;
  status: "reserved" | "dispatched" | "settled" | "released";
  reserved_at: number;
  dispatched_at: number | null;
  settled_at: number | null;
  purpose: string;
}

function money(value: number, round: "up" | "down" = "up"): number {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / MICRO_USD) throw new Error("Invalid USD amount");
  return round === "up" ? Math.ceil(value * MICRO_USD) : Math.floor(value * MICRO_USD);
}
function timestamp(now: number): void {
  if (!Number.isFinite(now) || now < 0 || now > 8.64e15) throw new Error("Invalid budget timestamp");
}
function requestKey(requestId: string): void {
  if (!requestId.trim() || requestId.length > 512) throw new Error("A bounded unique request id is required");
}

/**
 * Cross-process ledger for NEW OpenRouter spending from its activation date.
 * UTC day/month caps, integer micro-USD, atomic SQLite admission. This does not cap other
 * consumers of the same provider key. Pending requests never expire or unlock automatically.
 */
export class BudgetLedger {
  private readonly db: Database;
  private readonly dailyMicro: number;
  private readonly monthlyMicro: number;

  constructor(path: string, limits: BudgetLimits = {}) {
    this.dailyMicro = money(limits.dailyCapUsd ?? 10, "down");
    this.monthlyMicro = money(limits.monthlyCapUsd ?? 30, "down");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA busy_timeout = 10000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS budget_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS budget_requests (
        request_id TEXT PRIMARY KEY,
        estimated_micro INTEGER NOT NULL CHECK (estimated_micro >= 0),
        actual_micro INTEGER CHECK (actual_micro >= 0),
        status TEXT NOT NULL CHECK (status IN ('reserved','dispatched','settled','released')),
        reserved_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        settled_at INTEGER,
        purpose TEXT NOT NULL DEFAULT 'execution'
      );
      CREATE INDEX IF NOT EXISTS budget_settled_at ON budget_requests (status, settled_at);
      CREATE TABLE IF NOT EXISTS budget_generations (request_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL);
    `);
    // Migration: ledgers created before purposes default existing rows to 'execution'.
    const hasPurpose = this.db.query("SELECT COUNT(*) AS n FROM pragma_table_info('budget_requests') WHERE name='purpose'").get() as { n: number };
    if (!hasPurpose.n) this.db.exec("ALTER TABLE budget_requests ADD COLUMN purpose TEXT NOT NULL DEFAULT 'execution'");
    try {
      this.atomic(() => {
        for (const [key, value] of [["daily_micro", this.dailyMicro], ["monthly_micro", this.monthlyMicro]] as const) {
          this.db.query("INSERT OR IGNORE INTO budget_settings(key,value) VALUES (?,?)").run(key, value);
          const saved = this.db.query("SELECT value FROM budget_settings WHERE key=?").get(key) as { value: number };
          if (saved.value !== value) throw new Error("Ledger caps differ from requested caps; explicit budget migration is required");
        }
      });
    } catch (error) { this.db.close(); throw error; }
  }

  private atomic<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private row(requestId: string): Row | undefined {
    return (this.db.query("SELECT * FROM budget_requests WHERE request_id=?").get(requestId) as Row | null) ?? undefined;
  }

  reserve(requestId: string, estimatedUsd: number, now = Date.now(), options: { purpose?: BudgetPurpose; subcaps?: BudgetSubcaps } = {}): ReserveResult {
    requestKey(requestId); timestamp(now);
    const estimate = money(estimatedUsd);
    if (estimate === 0) throw new Error("Paid requests require a positive conservative forecast");
    const purpose = options.purpose ?? "execution";
    return this.atomic(() => {
      const existing = this.row(requestId);
      if (existing) {
        if (existing.estimated_micro !== estimate) throw new Error("Request id was reused with a different estimate");
        if (existing.status === "released" || existing.status === "settled") return { ok: false, reason: "request-finalized", snapshot: this.snapshot(now) };
        return { ok: true, idempotent: true, status: existing.status, estimatedUsd: estimate / MICRO_USD, snapshot: this.snapshot(now) };
      }
      const before = this.snapshot(now);
      if (money(before.dailyCommittedUsd) + estimate > this.dailyMicro) return { ok: false, reason: "daily-cap", snapshot: before };
      if (money(before.monthlyCommittedUsd) + estimate > this.monthlyMicro) return { ok: false, reason: "monthly-cap", snapshot: before };
      // Purpose subcaps are INSIDE the global caps: they can only further
      // restrict this purpose, never create spending capacity beyond them.
      if (purpose !== "execution" && options.subcaps) {
        const perPurpose = this.purposeCommitted(purpose, now);
        const { dailyCapUsd, monthlyCapUsd } = options.subcaps;
        if (dailyCapUsd !== undefined && perPurpose.day + estimate > money(dailyCapUsd, "down")) return { ok: false, reason: "daily-cap", snapshot: before };
        if (monthlyCapUsd !== undefined && perPurpose.month + estimate > money(monthlyCapUsd, "down")) return { ok: false, reason: "monthly-cap", snapshot: before };
      }
      this.db.query("INSERT INTO budget_requests(request_id,estimated_micro,status,reserved_at,purpose) VALUES (?,?,'reserved',?,?)").run(requestId, estimate, now, purpose);
      return { ok: true, idempotent: false, status: "reserved", estimatedUsd: estimate / MICRO_USD, snapshot: this.snapshot(now) };
    });
  }

  private purposeCommitted(purpose: string, now: number): { day: number; month: number } {
    const date = new Date(now);
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const dayEnd = dayStart + 86_400_000;
    const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const sums = this.db.query(`SELECT
      COALESCE(SUM(CASE WHEN status='settled' AND settled_at>=? AND settled_at<? THEN COALESCE(actual_micro, estimated_micro) ELSE 0 END),0) AS day,
      COALESCE(SUM(CASE WHEN status='settled' AND settled_at>=? AND settled_at<? THEN COALESCE(actual_micro, estimated_micro) ELSE 0 END),0) AS month,
      COALESCE(SUM(CASE WHEN status IN ('reserved','dispatched') AND reserved_at>=? AND reserved_at<? THEN estimated_micro ELSE 0 END),0) AS dayPending,
      COALESCE(SUM(CASE WHEN status IN ('reserved','dispatched') AND reserved_at>=? AND reserved_at<? THEN estimated_micro ELSE 0 END),0) AS monthPending
      FROM budget_requests WHERE purpose=?`).get(dayStart, dayEnd, monthStart, monthEnd, dayStart, dayEnd, monthStart, monthEnd, purpose) as { day: number; month: number; dayPending: number; monthPending: number };
    return { day: sums.day + sums.dayPending, month: sums.month + sums.monthPending };
  }

  /** Call once immediately before handing the request to the provider; use a new id for each HTTP attempt. */
  markDispatched(requestId: string, now = Date.now()): boolean {
    requestKey(requestId); timestamp(now);
    return this.atomic(() => {
      const row = this.row(requestId);
      if (!row || row.status === "released" || row.status === "settled") return false;
      if (row.status === "dispatched") return false; // A repeated callback must not dispatch again.
      this.db.query("UPDATE budget_requests SET status='dispatched',dispatched_at=? WHERE request_id=?").run(now, requestId);
      return true;
    });
  }

  /** Unknown provider cost must retain the reservation. Never call this with an invented/default zero. */
  settle(requestId: string, actualUsd: number, now = Date.now()): Settlement {
    requestKey(requestId); timestamp(now);
    const actual = money(actualUsd);
    return this.atomic(() => {
      const row = this.row(requestId);
      if (!row || row.status === "released") throw new Error("Cannot settle an absent or released reservation");
      if (row.status === "settled" && row.actual_micro !== actual) throw new Error("Conflicting actual cost for an already settled request");
      const idempotent = row.status === "settled";
      if (!idempotent) this.db.query("UPDATE budget_requests SET status='settled',actual_micro=?,settled_at=? WHERE request_id=?").run(actual, now, requestId);
      return { idempotent, actualUsd: actual / MICRO_USD, estimateUsd: row.estimated_micro / MICRO_USD, overEstimateUsd: Math.max(0, actual - row.estimated_micro) / MICRO_USD };
    });
  }

  /** Only for a request the caller knows never reached dispatch. Dispatched/crashed requests remain held. */
  releaseBeforeDispatch(requestId: string): boolean {
    requestKey(requestId);
    return this.atomic(() => {
      const row = this.row(requestId);
      if (!row) return false;
      if (row.status === "released") return true;
      if (row.status !== "reserved") return false;
      this.db.query("UPDATE budget_requests SET status='released' WHERE request_id=?").run(requestId);
      return true;
    });
  }

  snapshot(now = Date.now()): BudgetSnapshot {
    timestamp(now);
    const date = new Date(now);
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const dayEnd = dayStart + 86_400_000;
    const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    // A single SELECT gives one consistent read snapshot even when another process settles.
    const sums = this.db.query(`SELECT
      COALESCE(SUM(CASE WHEN status='settled' AND settled_at>=? AND settled_at<? THEN actual_micro ELSE 0 END),0) AS day,
      COALESCE(SUM(CASE WHEN status='settled' AND settled_at>=? AND settled_at<? THEN actual_micro ELSE 0 END),0) AS month,
      COALESCE(SUM(CASE WHEN status IN ('reserved','dispatched') THEN estimated_micro ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN status IN ('reserved','dispatched') THEN 1 ELSE 0 END),0) AS count,
      COALESCE(SUM(CASE WHEN status='settled' THEN estimated_micro ELSE 0 END),0) AS forecast,
      COALESCE(SUM(CASE WHEN status='settled' THEN actual_micro ELSE 0 END),0) AS realized,
      COALESCE(SUM(CASE WHEN status='settled' THEN 1 ELSE 0 END),0) AS settledCount
      FROM budget_requests`).get(dayStart, dayEnd, monthStart, monthEnd) as
      { day: number; month: number; pending: number; count: number; forecast: number; realized: number; settledCount: number };
    return {
      timezone: "UTC", dailyCapUsd: this.dailyMicro / MICRO_USD, monthlyCapUsd: this.monthlyMicro / MICRO_USD,
      dailySpentUsd: sums.day / MICRO_USD, monthlySpentUsd: sums.month / MICRO_USD,
      pendingUsd: sums.pending / MICRO_USD, pendingCount: sums.count,
      dailyCommittedUsd: (sums.day + sums.pending) / MICRO_USD, monthlyCommittedUsd: (sums.month + sums.pending) / MICRO_USD,
      dailyRemainingUsd: Math.max(0, this.dailyMicro - sums.day - sums.pending) / MICRO_USD,
      monthlyRemainingUsd: Math.max(0, this.monthlyMicro - sums.month - sums.pending) / MICRO_USD,
      ...(sums.settledCount > 0 ? {
        forecast: {
          settledCount: sums.settledCount,
          forecastUsd: sums.forecast / MICRO_USD,
          realizedUsd: sums.realized / MICRO_USD,
          // Realized / forecast. 1.0 means the bound was exactly right; 0.1
          // means the bound reserved ten times the money actually spent.
          ratio: sums.forecast > 0 ? sums.realized / sums.forecast : 0,
        },
      } : {}),
    };
  }
  close(): void { this.db.close(); }
  attachGeneration(requestId: string, generationId: string): void {
    requestKey(requestId);
    if (!/^gen-[A-Za-z0-9_-]+$/.test(generationId)) return;
    this.db.query('INSERT OR IGNORE INTO budget_generations(request_id,generation_id) VALUES (?,?)').run(requestId,generationId);
  }
  pendingGenerations(): Array<{requestId:string;generationId:string}> {
    return this.db.query("SELECT r.request_id AS requestId,g.generation_id AS generationId FROM budget_requests r JOIN budget_generations g ON g.request_id=r.request_id WHERE r.status='dispatched' ORDER BY r.reserved_at LIMIT 20").all() as any;
  }
}

export interface CostForecast {
  /** Uncached input; if passing total serialized input, omit separate cache token counts. */
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  maxOutputTokens: number;
  /** Live effective provider rates, USD per million tokens, including any long-context tier. */
  rates: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  safetyMultiplier?: number;
}

/** Forecast assumes every prompt token pays the highest input/cache rate; no warm-cache discount. */
export function estimateUpperBoundUsd(input: CostForecast): number {
  const tokens = [input.inputTokens, input.cacheReadTokens ?? 0, input.cacheWriteTokens ?? 0, input.maxOutputTokens];
  if (tokens.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("Forecast needs nonnegative integer token bounds");
  const rates = [input.rates.input, input.rates.output, input.rates.cacheRead ?? input.rates.input, input.rates.cacheWrite ?? input.rates.input];
  if (rates.some(value => !Number.isFinite(value) || value < 0)) throw new Error("Forecast needs valid live prices");
  const multiplier = input.safetyMultiplier ?? 1.15;
  if (!Number.isFinite(multiplier) || multiplier < 1) throw new Error("Forecast safety multiplier cannot lower the upper bound");
  const promptCost = (tokens[0]! + tokens[1]! + tokens[2]!) * Math.max(rates[0]!, rates[2]!, rates[3]!) / MICRO_USD;
  const outputCost = tokens[3]! * rates[1]! / MICRO_USD;
  return money((promptCost + outputCost) * multiplier) / MICRO_USD;
}
