import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the cache and oura modules so worker tests are pure unit tests
// with no D1 or network I/O.
vi.mock("../cache", () => ({
  datesInRange: vi.fn(() => ["2026-04-15", "2026-04-16", "2026-04-17"]),
  defaultStart: vi.fn(() => "2026-04-15"),
  defaultEnd: vi.fn(() => "2026-04-22"),
  getCachedRange: vi.fn(),
  setCachedRange: vi.fn(),
}));

vi.mock("../oura", () => ({
  getDailySleep: vi.fn(),
  getSleepSessions: vi.fn(),
  getDailyReadiness: vi.fn(),
  getDailyActivity: vi.fn(),
  getDailySpo2: vi.fn(),
  getWorkouts: vi.fn(),
  getDailyStress: vi.fn(),
}));

import * as cache from "../cache";
import * as oura from "../oura";
// Worker is the default export; import after mocks are set up.
import worker from "../index";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeEnv(token = "test-token"): { OURA_API_TOKEN: string; DB: D1Database } {
  return {
    OURA_API_TOKEN: token,
    DB: {} as D1Database,
  };
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} };
}

function jsonRpc(method: string, params?: Record<string, unknown>, id: number = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function post(path: string, body: string, env = makeEnv(), ctx = makeCtx()) {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
    env,
    ctx,
  );
}

async function parseResult(res: Response) {
  const json = await res.json() as { result?: { content?: Array<{ text: string }> }; error?: unknown };
  if (json.result?.content?.[0]) {
    return JSON.parse(json.result.content[0].text);
  }
  return json;
}

const CACHE_HIT = {
  hits: new Map([
    ["2026-04-15", { day: "2026-04-15", score: 80 }],
    ["2026-04-16", { day: "2026-04-16", score: 85 }],
    ["2026-04-17", { day: "2026-04-17", score: 90 }],
  ]),
  misses: [] as string[],
};

const CACHE_MISS = {
  hits: new Map<string, unknown>(),
  misses: ["2026-04-15", "2026-04-16", "2026-04-17"],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cache.getCachedRange).mockResolvedValue(CACHE_MISS);
  vi.mocked(cache.setCachedRange).mockResolvedValue(undefined);
  vi.mocked(oura.getDailySleep).mockResolvedValue({ data: [{ day: "2026-04-15", score: 80 }] });
  vi.mocked(oura.getWorkouts).mockResolvedValue({ data: [] });
  vi.mocked(oura.getDailyActivity).mockResolvedValue({ data: [], next_token: null });
  vi.mocked(oura.getDailyReadiness).mockResolvedValue({ data: [] });
  vi.mocked(oura.getDailySpo2).mockResolvedValue({ data: [] });
  vi.mocked(oura.getDailyStress).mockResolvedValue({ data: [] });
  vi.mocked(oura.getSleepSessions).mockResolvedValue({ data: [], next_token: null });
});

// ── Routing ───────────────────────────────────────────────────────────────────

describe("routing", () => {
  it("OPTIONS returns 204 with CORS headers", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/mcp/sleep", { method: "OPTIONS" }),
      makeEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("/health returns status ok", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/health"),
      makeEnv(),
      makeCtx(),
    );
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("/ also returns status ok", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/"),
      makeEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(200);
  });

  it("unknown path returns 404", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/unknown"),
      makeEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(404);
  });

  it("non-POST to /mcp/sleep returns 405", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/mcp/sleep"),
      makeEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(405);
  });
});

// ── Missing token ─────────────────────────────────────────────────────────────

describe("missing OURA_API_TOKEN", () => {
  it("returns 500 with actionable error", async () => {
    const res = await post("/mcp/sleep", jsonRpc("tools/list"), makeEnv(""));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain("OURA_API_TOKEN");
  });
});

// ── JSON-RPC methods ──────────────────────────────────────────────────────────

describe("initialize", () => {
  it("returns protocol version and capabilities", async () => {
    const res = await post("/mcp/sleep", jsonRpc("initialize"));
    const body = await res.json() as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe("2024-11-05");
  });
});

describe("tools/list", () => {
  it("returns SLEEP_TOOLS for /mcp/sleep", async () => {
    const res = await post("/mcp/sleep", jsonRpc("tools/list"));
    const body = await res.json() as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("oura_daily_sleep");
    expect(names).not.toContain("oura_daily_activity");
    expect(names).not.toContain("oura_personal_info");
    expect(names).not.toContain("oura_heart_rate");
  });

  it("returns ACTIVITY_TOOLS for /mcp/activity", async () => {
    const res = await post("/mcp/activity", jsonRpc("tools/list"));
    const body = await res.json() as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("oura_daily_activity");
    expect(names).not.toContain("oura_daily_sleep");
    expect(names).not.toContain("oura_heart_rate");
  });
});

describe("ping", () => {
  it("returns an empty result", async () => {
    const res = await post("/mcp/sleep", jsonRpc("ping"));
    const body = await res.json() as { result: unknown };
    expect(body.result).toEqual({});
  });
});

describe("notifications", () => {
  it("returns 202 for notification methods (no id)", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    const res = await post("/mcp/sleep", body);
    expect(res.status).toBe(202);
  });
});

describe("unknown method", () => {
  it("returns error code -32601", async () => {
    const res = await post("/mcp/sleep", jsonRpc("nonexistent/method"));
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });
});

describe("malformed JSON", () => {
  it("returns error code -32700", async () => {
    const res = await post("/mcp/sleep", "not json");
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});

// ── tools/call — date-range tool (oura_daily_sleep) ──────────────────────────

describe("tools/call — date-range tool (oura_daily_sleep)", () => {
  it("returns _cache: hit on full cache hit", async () => {
    vi.mocked(cache.getCachedRange).mockResolvedValueOnce(CACHE_HIT);
    const res = await post("/mcp/sleep", jsonRpc("tools/call", { name: "oura_daily_sleep", arguments: {} }));
    const data = await parseResult(res);
    expect(data._cache).toBe("hit");
    expect(oura.getDailySleep).not.toHaveBeenCalled();
  });

  it("fetches Oura on cache miss and returns _cache: miss", async () => {
    vi.mocked(cache.getCachedRange).mockResolvedValueOnce(CACHE_MISS);
    vi.mocked(oura.getDailySleep).mockResolvedValueOnce({
      data: [{ day: "2026-04-15", score: 80 }],
    });
    const ctx = makeCtx();
    const res = await post("/mcp/sleep", jsonRpc("tools/call", { name: "oura_daily_sleep", arguments: {} }), makeEnv(), ctx);
    const data = await parseResult(res);
    expect(data._cache).toBe("miss");
    expect(data.data).toHaveLength(1);
    expect(ctx.waitUntil).toHaveBeenCalled(); // cache write scheduled
  });

  it("does not cache empty Oura responses", async () => {
    vi.mocked(cache.getCachedRange).mockResolvedValueOnce(CACHE_MISS);
    vi.mocked(oura.getDailySleep).mockResolvedValueOnce({ data: [] });
    const ctx = makeCtx();
    await post("/mcp/sleep", jsonRpc("tools/call", { name: "oura_daily_sleep", arguments: {} }), makeEnv(), ctx);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("bypasses cache on skip_cache: true", async () => {
    vi.mocked(oura.getDailySleep).mockResolvedValueOnce({ data: [] });
    await post("/mcp/sleep", jsonRpc("tools/call", { name: "oura_daily_sleep", arguments: { skip_cache: true } }));
    expect(cache.getCachedRange).not.toHaveBeenCalled();
  });
});

// ── tools/call — ?no_cache query param ───────────────────────────────────────

describe("tools/call — ?no_cache query param", () => {
  it("bypasses cache for all tools in the request", async () => {
    vi.mocked(oura.getDailySleep).mockResolvedValueOnce({ data: [] });
    const env = makeEnv();
    const ctx = makeCtx();
    await worker.fetch(
      new Request("http://localhost/mcp/sleep?no_cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: jsonRpc("tools/call", { name: "oura_daily_sleep", arguments: {} }),
      }),
      env,
      ctx,
    );
    expect(cache.getCachedRange).not.toHaveBeenCalled();
  });
});

// ── tools/call — all other date-range tools route through fetchFromOura ───────

describe("tools/call — all other date-range tools route through fetchFromOura", () => {
  const dateRangeTools = [
    { tool: "oura_sleep_sessions",   endpoint: "/mcp/sleep",    mock: "getSleepSessions" },
    { tool: "oura_daily_readiness",  endpoint: "/mcp/sleep",    mock: "getDailyReadiness" },
    { tool: "oura_daily_activity",   endpoint: "/mcp/activity", mock: "getDailyActivity" },
    { tool: "oura_daily_spo2",       endpoint: "/mcp/sleep",    mock: "getDailySpo2" },
    { tool: "oura_workouts",         endpoint: "/mcp/activity", mock: "getWorkouts" },
    { tool: "oura_daily_stress",     endpoint: "/mcp/activity", mock: "getDailyStress" },
  ] as const;

  for (const { tool, endpoint, mock } of dateRangeTools) {
    it(`${tool} returns 200 and calls oura.${mock}`, async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(oura[mock]).mockResolvedValueOnce({ data: [] } as any);
      const res = await post(endpoint, jsonRpc("tools/call", { name: tool, arguments: {} }));
      expect(res.status).toBe(200);
      expect(oura[mock]).toHaveBeenCalled();
    });
  }
});

// ── tools/call — exclusiveEnd: +1 day added for non-daily_sleep tools ─────────
//
// handleDateRangeTool passes `missEnd` (last element of cache.misses) to
// fetchFromOura, not the original tool arg. The CACHE_MISS mock has
// misses: ["2026-04-15", "2026-04-16", "2026-04-17"], so missEnd = "2026-04-17".
// daily_sleep receives it unchanged; exclusive tools receive "2026-04-18" (+1).

describe("tools/call — exclusiveEnd behavior", () => {
  it("passes end_date unchanged to getDailySleep (inclusive endpoint)", async () => {
    vi.mocked(oura.getDailySleep).mockResolvedValueOnce({ data: [] });
    await post("/mcp/sleep", jsonRpc("tools/call", { name: "oura_daily_sleep", arguments: {} }));
    // missEnd = "2026-04-17" from CACHE_MISS mock — passed through as-is for daily_sleep
    expect(oura.getDailySleep).toHaveBeenCalledWith("test-token", "2026-04-15", "2026-04-17");
  });

  it("adds +1 day to end_date for oura_sleep_sessions (exclusive endpoint)", async () => {
    vi.mocked(oura.getSleepSessions).mockResolvedValueOnce({ data: [], next_token: null });
    await post("/mcp/sleep", jsonRpc("tools/call", { name: "oura_sleep_sessions", arguments: {} }));
    // missEnd = "2026-04-17" → exclusiveEnd adds 1 day → "2026-04-18"
    expect(oura.getSleepSessions).toHaveBeenCalledWith("test-token", "2026-04-15", "2026-04-18");
  });

  it("adds +1 day to end_date for oura_daily_activity (exclusive endpoint)", async () => {
    vi.mocked(oura.getDailyActivity).mockResolvedValueOnce({ data: [], next_token: null });
    await post("/mcp/activity", jsonRpc("tools/call", { name: "oura_daily_activity", arguments: {} }));
    // missEnd = "2026-04-17" → exclusiveEnd adds 1 day → "2026-04-18"
    expect(oura.getDailyActivity).toHaveBeenCalledWith("test-token", "2026-04-15", "2026-04-18");
  });

  it("adds +1 day to end_date for oura_workouts (exclusive endpoint)", async () => {
    vi.mocked(oura.getWorkouts).mockResolvedValueOnce({ data: [] });
    await post("/mcp/activity", jsonRpc("tools/call", { name: "oura_workouts", arguments: {} }));
    // missEnd = "2026-04-17" → exclusiveEnd adds 1 day → "2026-04-18"
    expect(oura.getWorkouts).toHaveBeenCalledWith("test-token", "2026-04-15", "2026-04-18");
  });
});

// ── tools/call — groupByDay merges multiple items per day ─────────────────────

describe("tools/call — groupByDay merges multiple items per day", () => {
  it("returns all items when sleep_sessions has 3 entries on the same day", async () => {
    // Three items for the same day exercises the Array.isArray(existing) branch in groupByDay
    vi.mocked(oura.getSleepSessions).mockResolvedValueOnce({
      data: [
        { day: "2026-04-15", session: "nap1" },
        { day: "2026-04-15", session: "nap2" },
        { day: "2026-04-15", session: "main" },
      ],
      next_token: null,
    });
    const res = await post(
      "/mcp/sleep",
      jsonRpc("tools/call", { name: "oura_sleep_sessions", arguments: {} }),
    );
    const data = await parseResult(res);
    expect(data.data).toHaveLength(3);
  });
});

// ── tools/call — unknown tool ─────────────────────────────────────────────────

describe("tools/call — unknown tool", () => {
  it("returns isError: true", async () => {
    const res = await post("/mcp/sleep", jsonRpc("tools/call", { name: "oura_nonexistent", arguments: {} }));
    const body = await res.json() as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
  });
});

describe("tools/call — missing tool name", () => {
  it("returns 400", async () => {
    const res = await post("/mcp/sleep", jsonRpc("tools/call", { arguments: {} }));
    expect(res.status).toBe(400);
  });
});

describe("tools/call — Oura API error", () => {
  it("surfaces the error message in the response", async () => {
    vi.mocked(cache.getCachedRange).mockResolvedValueOnce(CACHE_MISS);
    vi.mocked(oura.getDailySleep).mockRejectedValueOnce(new Error("Oura API error 500: timeout"));
    const res = await post("/mcp/sleep", jsonRpc("tools/call", { name: "oura_daily_sleep", arguments: {} }));
    const body = await res.json() as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain("Oura API error 500");
  });
});
