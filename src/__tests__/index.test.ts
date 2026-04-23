import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the cache and oura modules so worker tests are pure unit tests
// with no D1 or network I/O.
vi.mock("../cache", () => ({
  datesInRange: vi.fn(() => ["2026-04-15", "2026-04-16", "2026-04-17"]),
  defaultStart: vi.fn(() => "2026-04-15"),
  defaultEnd: vi.fn(() => "2026-04-22"),
  getCachedRange: vi.fn(),
  setCachedRange: vi.fn(),
  getCachedSingleton: vi.fn(),
  setCachedSingleton: vi.fn(),
}));

vi.mock("../oura", () => ({
  getPersonalInfo: vi.fn(),
  getDailySleep: vi.fn(),
  getSleepSessions: vi.fn(),
  getDailyReadiness: vi.fn(),
  getDailyActivity: vi.fn(),
  getHeartRate: vi.fn(),
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
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
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
  vi.mocked(cache.getCachedSingleton).mockResolvedValue(null);
  vi.mocked(cache.setCachedRange).mockResolvedValue(undefined);
  vi.mocked(cache.setCachedSingleton).mockResolvedValue(undefined);
  vi.mocked(oura.getDailySleep).mockResolvedValue({ data: [{ day: "2026-04-15", score: 80 }] });
  vi.mocked(oura.getPersonalInfo).mockResolvedValue({ age: 30, weight: 75 });
  vi.mocked(oura.getHeartRate).mockResolvedValue({ data: [{ bpm: 60, timestamp: "2026-04-15T00:00:00Z" }] });
  vi.mocked(oura.getWorkouts).mockResolvedValue({ data: [] });
  vi.mocked(oura.getDailyActivity).mockResolvedValue({ data: [] });
  vi.mocked(oura.getDailyReadiness).mockResolvedValue({ data: [] });
  vi.mocked(oura.getDailySpo2).mockResolvedValue({ data: [] });
  vi.mocked(oura.getDailyStress).mockResolvedValue({ data: [] });
  vi.mocked(oura.getSleepSessions).mockResolvedValue({ data: [] });
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
  });

  it("returns ACTIVITY_TOOLS for /mcp/activity", async () => {
    const res = await post("/mcp/activity", jsonRpc("tools/list"));
    const body = await res.json() as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("oura_daily_activity");
    expect(names).not.toContain("oura_daily_sleep");
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

// ── tools/call ────────────────────────────────────────────────────────────────

describe("tools/call — oura_personal_info (singleton)", () => {
  it("returns cached result on hit", async () => {
    vi.mocked(cache.getCachedSingleton).mockResolvedValueOnce({ age: 30 });
    const res = await post("/mcp/sleep", jsonRpc("tools/call", { name: "oura_personal_info", arguments: {} }));
    const data = await parseResult(res);
    expect(data._cache).toBe("hit");
    expect(oura.getPersonalInfo).not.toHaveBeenCalled();
  });

  it("fetches from Oura on miss and caches result", async () => {
    const ctx = makeCtx();
    const res = await post("/mcp/sleep", jsonRpc("tools/call", { name: "oura_personal_info", arguments: {} }), makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(oura.getPersonalInfo).toHaveBeenCalledWith("test-token");
    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it("bypasses cache when skip_cache is true", async () => {
    vi.mocked(cache.getCachedSingleton).mockResolvedValueOnce({ age: 99 });
    await post("/mcp/sleep", jsonRpc("tools/call", { name: "oura_personal_info", arguments: { skip_cache: true } }));
    expect(oura.getPersonalInfo).toHaveBeenCalled();
  });
});

describe("tools/call — oura_heart_rate (passthrough)", () => {
  it("calls Oura directly without touching the cache", async () => {
    const res = await post(
      "/mcp/activity",
      jsonRpc("tools/call", {
        name: "oura_heart_rate",
        arguments: { start_datetime: "2026-04-15T00:00:00Z" },
      }),
    );
    expect(res.status).toBe(200);
    expect(oura.getHeartRate).toHaveBeenCalled();
    expect(cache.getCachedRange).not.toHaveBeenCalled();
  });
});

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
      vi.mocked(oura[mock]).mockResolvedValueOnce({ data: [] });
      const res = await post(endpoint, jsonRpc("tools/call", { name: tool, arguments: {} }));
      expect(res.status).toBe(200);
      expect(oura[mock]).toHaveBeenCalled();
    });
  }
});

describe("tools/call — groupByDay merges multiple items per day", () => {
  it("returns all items when sleep_sessions has 3 entries on the same day", async () => {
    // Three items for the same day exercises the Array.isArray(existing) branch in groupByDay
    vi.mocked(oura.getSleepSessions).mockResolvedValueOnce({
      data: [
        { day: "2026-04-15", session: "nap1" },
        { day: "2026-04-15", session: "nap2" },
        { day: "2026-04-15", session: "main" },
      ],
    });
    const res = await post(
      "/mcp/sleep",
      jsonRpc("tools/call", { name: "oura_sleep_sessions", arguments: {} }),
    );
    const data = await parseResult(res);
    expect(data.data).toHaveLength(3);
  });
});

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
