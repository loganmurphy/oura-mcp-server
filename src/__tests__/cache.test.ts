import { describe, it, expect } from "vitest";
import {
  datesInRange,
  defaultStart,
  defaultEnd,
  getCachedRange,
  setCachedRange,
} from "../cache";


function createMockD1() {
  const rows = new Map<string, { data: string; fetched_at: number }>();
  const rowKey = (metric: string, dateKey: string) => `${metric}::${dateKey}`;

  function makeStmt(sql: string, boundArgs: unknown[] = []) {
    const isInsert = sql.trimStart().toUpperCase().startsWith("INSERT");
    const isSelectRange = sql.includes("date_key IN");
    const isSelectSingle = sql.includes("date_key = ?") && !isSelectRange;

    const stmt = {
      bind(...args: unknown[]) {
        return makeStmt(sql, args);
      },
      async all<T>() {
        if (isSelectRange) {
          const [metric, ...dates] = boundArgs as [string, ...string[]];
          const results = (dates as string[]).flatMap((d) => {
            const row = rows.get(rowKey(metric, d));
            return row
              ? [{ metric, date_key: d, data: row.data, fetched_at: row.fetched_at } as T]
              : [];
          });
          return { results };
        }
        return { results: [] as T[] };
      },
      async first<T>() {
        if (isSelectSingle) {
          const [metric, dateKey] = boundArgs as [string, string];
          const row = rows.get(rowKey(metric, dateKey));
          return (
            row ? { metric, date_key: dateKey, data: row.data, fetched_at: row.fetched_at } : null
          ) as T | null;
        }
        return null as T | null;
      },
      async run() {
        if (isInsert) {
          const [metric, dateKey, data, fetchedAt] = boundArgs as [string, string, string, number];
          rows.set(rowKey(metric, dateKey), { data, fetched_at: fetchedAt });
        }
      },
    };
    return stmt;
  }

  return {
    _rows: rows,
    prepare(sql: string) {
      return makeStmt(sql);
    },
    async batch(stmts: Array<{ run(): Promise<void> }>) {
      for (const stmt of stmts) await stmt.run();
    },
  } as unknown as D1Database & { _rows: Map<string, { data: string; fetched_at: number }> };
}


describe("datesInRange", () => {
  it("returns a single date when start equals end", () => {
    expect(datesInRange("2026-04-01", "2026-04-01")).toEqual(["2026-04-01"]);
  });

  it("returns all dates inclusive", () => {
    expect(datesInRange("2026-04-01", "2026-04-03")).toEqual([
      "2026-04-01",
      "2026-04-02",
      "2026-04-03",
    ]);
  });

  it("handles month boundaries", () => {
    const dates = datesInRange("2026-01-30", "2026-02-02");
    expect(dates).toEqual(["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  });

  it("returns empty array when start is after end", () => {
    expect(datesInRange("2026-04-05", "2026-04-01")).toEqual([]);
  });
});


describe("defaultStart / defaultEnd", () => {
  it("defaultEnd returns today in YYYY-MM-DD format", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(defaultEnd()).toBe(today);
  });

  it("defaultStart returns 7 days ago in YYYY-MM-DD format", () => {
    const expected = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    expect(defaultStart()).toBe(expected);
  });
});


describe("getCachedRange", () => {
  it("returns all misses when the DB is empty", async () => {
    const db = createMockD1();
    const result = await getCachedRange(db, "daily_sleep", ["2026-04-01", "2026-04-02"]);
    expect(result.hits.size).toBe(0);
    expect(result.misses).toEqual(["2026-04-01", "2026-04-02"]);
  });

  it("returns an empty result when dates array is empty", async () => {
    const db = createMockD1();
    const result = await getCachedRange(db, "daily_sleep", []);
    expect(result.hits.size).toBe(0);
    expect(result.misses).toEqual([]);
  });

  it("returns a hit for a freshly cached row", async () => {
    const db = createMockD1();
    await setCachedRange(db, "daily_sleep", [
      { dateKey: "2026-04-01", data: { score: 85 } },
    ]);
    const result = await getCachedRange(db, "daily_sleep", ["2026-04-01"]);
    expect(result.hits.size).toBe(1);
    expect(result.hits.get("2026-04-01")).toEqual({ score: 85 });
    expect(result.misses).toEqual([]);
  });

  it("treats a stale row as a miss", async () => {
    const db = createMockD1();
    // Directly insert a row with fetched_at far in the past
    const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
    db._rows.set("daily_sleep::2026-01-01", {
      data: JSON.stringify({ score: 70 }),
      fetched_at: oldTime,
    });

    const result = await getCachedRange(db, "daily_sleep", ["2026-01-01"]);
    expect(result.hits.size).toBe(0);
    expect(result.misses).toEqual(["2026-01-01"]);
  });

  it("returns a hit for a fresh today row (5m TTL)", async () => {
    const db = createMockD1();
    const today = new Date().toISOString().slice(0, 10);
    db._rows.set(`daily_sleep::${today}`, {
      data: JSON.stringify({ score: 88 }),
      fetched_at: Date.now() - 2 * 60 * 1000, // 2min ago — within 5m TTL
    });
    const result = await getCachedRange(db, "daily_sleep", [today]);
    expect(result.hits.size).toBe(1);
    expect(result.misses).toEqual([]);
  });

  it("treats a stale today row as a miss (5m TTL exceeded)", async () => {
    const db = createMockD1();
    const today = new Date().toISOString().slice(0, 10);
    db._rows.set(`daily_sleep::${today}`, {
      data: JSON.stringify({ score: 70 }),
      fetched_at: Date.now() - 6 * 60 * 1000, // 6min ago — past 5m TTL
    });
    const result = await getCachedRange(db, "daily_sleep", [today]);
    expect(result.hits.size).toBe(0);
    expect(result.misses).toEqual([today]);
  });

  it("returns a hit for a fresh yesterday row (6h TTL)", async () => {
    const db = createMockD1();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    db._rows.set(`daily_sleep::${yesterday}`, {
      data: JSON.stringify({ score: 75 }),
      fetched_at: Date.now() - 2 * 60 * 60 * 1000, // 2h ago — within 6h TTL
    });
    const result = await getCachedRange(db, "daily_sleep", [yesterday]);
    expect(result.hits.size).toBe(1);
    expect(result.misses).toEqual([]);
  });

  it("treats a stale yesterday row as a miss (6h TTL exceeded)", async () => {
    const db = createMockD1();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    db._rows.set(`daily_sleep::${yesterday}`, {
      data: JSON.stringify({ score: 72 }),
      fetched_at: Date.now() - 7 * 60 * 60 * 1000, // 7h ago — past 6h TTL
    });
    const result = await getCachedRange(db, "daily_sleep", [yesterday]);
    expect(result.hits.size).toBe(0);
    expect(result.misses).toEqual([yesterday]);
  });

  it("returns a mix of hits and misses", async () => {
    const db = createMockD1();
    await setCachedRange(db, "workouts", [
      { dateKey: "2026-04-01", data: { activity: "hiking" } },
    ]);
    const result = await getCachedRange(db, "workouts", [
      "2026-04-01",
      "2026-04-02",
    ]);
    expect(result.hits.size).toBe(1);
    expect(result.misses).toEqual(["2026-04-02"]);
  });
});

describe("setCachedRange", () => {
  it("is a no-op for empty entries", async () => {
    const db = createMockD1();
    await setCachedRange(db, "daily_sleep", []);
    expect(db._rows.size).toBe(0);
  });

  it("stores multiple entries in one batch", async () => {
    const db = createMockD1();
    await setCachedRange(db, "daily_sleep", [
      { dateKey: "2026-04-01", data: { score: 80 } },
      { dateKey: "2026-04-02", data: { score: 90 } },
    ]);
    expect(db._rows.size).toBe(2);
  });

  it("overwrites an existing row on upsert", async () => {
    const db = createMockD1();
    await setCachedRange(db, "daily_sleep", [{ dateKey: "2026-04-01", data: { score: 80 } }]);
    await setCachedRange(db, "daily_sleep", [{ dateKey: "2026-04-01", data: { score: 95 } }]);
    const result = await getCachedRange(db, "daily_sleep", ["2026-04-01"]);
    expect((result.hits.get("2026-04-01") as { score: number }).score).toBe(95);
  });
});

