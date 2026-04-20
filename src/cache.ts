// D1-backed cache for Oura API responses.
//
// Each row stores one day's data for a given metric, enabling partial cache hits:
// if a 7-day query has 5 days cached we can serve those instantly and only fetch
// the 2 missing days from the Oura API.

const TTL: Record<"today" | "yesterday" | "older" | "singleton", number> = {
  today:     1  * 60 * 60 * 1000,  // 1h  — data still accumulating
  yesterday: 6  * 60 * 60 * 1000,  // 6h  — Oura may retroactively adjust
  older:     24 * 60 * 60 * 1000,  // 24h — stable historical data
  singleton: 24 * 60 * 60 * 1000,  // 24h — personal_info
};

function ttlFor(dateKey: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (dateKey === today) return TTL.today;
  if (dateKey === yesterday) return TTL.yesterday;
  return TTL.older;
}

function isStale(fetchedAt: number, dateKey: string): boolean {
  return Date.now() - fetchedAt > ttlFor(dateKey);
}

// ---------------------------------------------------------------------------
// Date-range cache (daily_sleep, sleep_sessions, readiness, activity, …)
// ---------------------------------------------------------------------------

export interface CacheResult {
  hits: Map<string, unknown>;   // date → cached item(s)
  misses: string[];             // dates not in cache or stale
}

export async function getCachedRange(
  db: D1Database,
  metric: string,
  dates: string[],
): Promise<CacheResult> {
  if (dates.length === 0) return { hits: new Map(), misses: [] };

  const placeholders = dates.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT date_key, data, fetched_at FROM oura_cache WHERE metric = ? AND date_key IN (${placeholders})`)
    .bind(metric, ...dates)
    .all<{ date_key: string; data: string; fetched_at: number }>();

  const hits = new Map<string, unknown>();
  for (const row of results) {
    if (!isStale(row.fetched_at, row.date_key)) {
      hits.set(row.date_key, JSON.parse(row.data));
    }
  }

  return {
    hits,
    misses: dates.filter((d) => !hits.has(d)),
  };
}

export async function setCachedRange(
  db: D1Database,
  metric: string,
  entries: Array<{ dateKey: string; data: unknown }>,
): Promise<void> {
  if (entries.length === 0) return;
  const now = Date.now();
  const stmts = entries.map(({ dateKey, data }) =>
    db
      .prepare("INSERT OR REPLACE INTO oura_cache (metric, date_key, data, fetched_at) VALUES (?, ?, ?, ?)")
      .bind(metric, dateKey, JSON.stringify(data), now),
  );
  await db.batch(stmts);
}

// ---------------------------------------------------------------------------
// Singleton cache (personal_info)
// ---------------------------------------------------------------------------

const SINGLETON_KEY = "__singleton__";

export async function getCachedSingleton(db: D1Database, metric: string): Promise<unknown | null> {
  const row = await db
    .prepare("SELECT data, fetched_at FROM oura_cache WHERE metric = ? AND date_key = ?")
    .bind(metric, SINGLETON_KEY)
    .first<{ data: string; fetched_at: number }>();

  if (!row || Date.now() - row.fetched_at > TTL.singleton) return null;
  return JSON.parse(row.data);
}

export async function setCachedSingleton(db: D1Database, metric: string, data: unknown): Promise<void> {
  const now = Date.now();
  await db
    .prepare("INSERT OR REPLACE INTO oura_cache (metric, date_key, data, fetched_at) VALUES (?, ?, ?, ?)")
    .bind(metric, SINGLETON_KEY, JSON.stringify(data), now)
    .run();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns every date string (YYYY-MM-DD) in [start, end] inclusive. */
export function datesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(start + "T12:00:00Z");
  const endDate = new Date(end + "T12:00:00Z");
  while (cur <= endDate) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

export function defaultStart(): string {
  return new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
}

export function defaultEnd(): string {
  return new Date().toISOString().slice(0, 10);
}
