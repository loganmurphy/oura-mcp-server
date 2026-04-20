import {
  getDailyActivity,
  getDailyReadiness,
  getDailySleep,
  getDailySpo2,
  getDailyStress,
  getHeartRate,
  getPersonalInfo,
  getSleepSessions,
  getWorkouts,
} from "./oura";
import {
  CacheResult,
  datesInRange,
  defaultEnd,
  defaultStart,
  getCachedRange,
  getCachedSingleton,
  setCachedRange,
  setCachedSingleton,
} from "./cache";
import { ACTIVITY_TOOLS, SLEEP_TOOLS, type ToolDef } from "./tools";

export interface Env {
  OURA_API_TOKEN: string;
  DB: D1Database;
}

// ---------------------------------------------------------------------------
// MCP protocol types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ---------------------------------------------------------------------------
// SSE helpers — used when we have partial cache hits so we can stream cached
// data back to the client immediately while fetching the missing dates from
// the Oura API in parallel.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function sseChunk(obj: unknown): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseResponse(readable: ReadableStream): Response {
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      ...CORS,
    },
  });
}

// ---------------------------------------------------------------------------
// Raw Oura fetchers (no cache)
// ---------------------------------------------------------------------------

type DateArgs = { start_date?: string; end_date?: string };
type DatetimeArgs = { start_datetime?: string; end_datetime?: string };

/** Fetch from Oura API and return the parsed response. */
async function fetchFromOura(
  name: string,
  args: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const d = args as DateArgs;
  const dt = args as DatetimeArgs;

  switch (name) {
    case "oura_personal_info":    return getPersonalInfo(token);
    case "oura_daily_sleep":      return getDailySleep(token, d.start_date, d.end_date);
    case "oura_sleep_sessions":   return getSleepSessions(token, d.start_date, d.end_date);
    case "oura_daily_readiness":  return getDailyReadiness(token, d.start_date, d.end_date);
    case "oura_daily_activity":   return getDailyActivity(token, d.start_date, d.end_date);
    case "oura_heart_rate":       return getHeartRate(token, dt.start_datetime, dt.end_datetime);
    case "oura_daily_spo2":       return getDailySpo2(token, d.start_date, d.end_date);
    case "oura_workouts":         return getWorkouts(token, d.start_date, d.end_date);
    case "oura_daily_stress":     return getDailyStress(token, d.start_date, d.end_date);
    default:                      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Cache-aware tool dispatch
// ---------------------------------------------------------------------------

/** Tools with per-day cacheable items (response.data[].day field). */
const DATE_KEYED_TOOLS = new Set([
  "oura_daily_sleep",
  "oura_sleep_sessions",
  "oura_daily_readiness",
  "oura_daily_activity",
  "oura_daily_spo2",
  "oura_workouts",
  "oura_daily_stress",
]);

/**
 * For date-keyed tools, items from the Oura response may be grouped per day
 * (e.g. sleep_sessions can have >1 session per night). We store all of a
 * day's items as a single cache entry (array or single object).
 */
function groupByDay(items: Array<{ day: string } & Record<string, unknown>>) {
  const map = new Map<string, unknown>();
  for (const item of items) {
    const existing = map.get(item.day);
    if (existing === undefined) {
      map.set(item.day, item);
    } else {
      // Multiple items for same day (e.g. naps + main sleep) → store as array
      map.set(item.day, Array.isArray(existing) ? [...existing, item] : [existing, item]);
    }
  }
  return map;
}

/**
 * Handle a date-range tool call with streaming cache support:
 *
 * 1. All dates cached & fresh  → return JSON immediately (fastest path)
 * 2. Some dates cached         → SSE: stream cached chunk first, fetch missing
 *                                dates from Oura, stream complete merged result
 * 3. No dates cached           → fetch all from Oura, return JSON, cache async
 */
async function handleDateRangeTool(
  id: string | number | null,
  toolName: string,
  args: Record<string, unknown>,
  token: string,
  db: D1Database,
  ctx: ExecutionContext,
): Promise<Response> {
  const start = (args["start_date"] as string | undefined) ?? defaultStart();
  const end   = (args["end_date"]   as string | undefined) ?? defaultEnd();
  const dates = datesInRange(start, end);
  const metric = toolName.replace("oura_", "");

  const cache: CacheResult = await getCachedRange(db, metric, dates);

  // ── Fast path: 100% cache hit ──────────────────────────────────────────
  if (cache.misses.length === 0) {
    const items = dates.flatMap((d) => {
      const v = cache.hits.get(d);
      return v === undefined ? [] : Array.isArray(v) ? v : [v];
    });
    return jsonResponse(ok(id, {
      content: [{ type: "text", text: JSON.stringify({ data: items, _cache: "hit" }, null, 2) }],
    }));
  }

  // ── Streaming path: partial or full miss ──────────────────────────────
  // We open an SSE stream so we can push the cached portion to the client
  // immediately while the Oura fetch is in flight.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const work = async () => {
    try {
      // 1. Flush cached dates immediately (if any)
      if (cache.hits.size > 0) {
        const cachedItems = dates.flatMap((d) => {
          const v = cache.hits.get(d);
          return v === undefined ? [] : Array.isArray(v) ? v : [v];
        });
        await writer.write(sseChunk(ok(id, {
          content: [{ type: "text", text: JSON.stringify({
            data:            cachedItems,
            _cache:          "partial",
            _cached_dates:   [...cache.hits.keys()],
            _fetching_dates: cache.misses,
          }, null, 2) }],
          _partial: true, // informational — not part of the MCP spec
        })));
      }

      // 2. Fetch only the missing date range from Oura
      const missStart = cache.misses[0]!;
      const missEnd   = cache.misses[cache.misses.length - 1]!;
      const freshResp = (await fetchFromOura(toolName, { start_date: missStart, end_date: missEnd }, token)) as
        { data: Array<{ day: string } & Record<string, unknown>> };

      // 3. Merge: cached dates + fresh dates, preserving original order
      const freshByDay = groupByDay(freshResp.data);
      const allItems = dates.flatMap((d) => {
        const v = cache.hits.get(d) ?? freshByDay.get(d);
        return v === undefined ? [] : Array.isArray(v) ? v : [v];
      });

      // 4. Send complete merged result
      await writer.write(sseChunk(ok(id, {
        content: [{ type: "text", text: JSON.stringify({
          data:   allItems,
          _cache: cache.hits.size > 0 ? "partial" : "miss",
        }, null, 2) }],
      })));

      // 5. Persist fresh items to D1 (non-blocking)
      const toCache = [...freshByDay.entries()].map(([dateKey, data]) => ({ dateKey, data }));
      ctx.waitUntil(setCachedRange(db, metric, toCache));

    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await writer.write(sseChunk(ok(id, {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      })));
    } finally {
      await writer.close();
    }
  };

  ctx.waitUntil(work());
  return sseResponse(readable);
}

/** Handle personal_info with singleton cache. */
async function handleSingletonTool(
  id: string | number | null,
  toolName: string,
  token: string,
  db: D1Database,
  ctx: ExecutionContext,
): Promise<Response> {
  const metric = toolName.replace("oura_", "");
  const cached = await getCachedSingleton(db, metric);
  if (cached !== null) {
    return jsonResponse(ok(id, {
      content: [{ type: "text", text: JSON.stringify({ ...cached as object, _cache: "hit" }, null, 2) }],
    }));
  }

  const data = await fetchFromOura(toolName, {}, token);
  ctx.waitUntil(setCachedSingleton(db, metric, data));
  return jsonResponse(ok(id, {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  }));
}

/** heart_rate uses datetimes not dates; skip per-day caching, pass through directly. */
async function handleHeartRateTool(
  id: string | number | null,
  args: Record<string, unknown>,
  token: string,
): Promise<Response> {
  const data = await fetchFromOura("oura_heart_rate", args, token);
  return jsonResponse(ok(id, {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  }));
}

// ---------------------------------------------------------------------------
// MCP request handler
// ---------------------------------------------------------------------------

async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  tools: ToolDef[],
  serverName: string,
): Promise<Response> {
  if (!env.OURA_API_TOKEN) {
    return jsonResponse(err(null, -32603, "OURA_API_TOKEN secret not configured"), 500);
  }

  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return jsonResponse(err(null, -32700, "Parse error"), 400);
  }

  const { id, method, params = {} } = body;

  if (id === undefined && method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    case "initialize":
      return jsonResponse(ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: "1.0.0" },
      }));

    case "tools/list":
      return jsonResponse(ok(id, { tools }));

    case "tools/call": {
      const toolName = params["name"] as string;
      const toolArgs = (params["arguments"] as Record<string, unknown>) ?? {};
      if (!toolName) return jsonResponse(err(id, -32602, "Missing tool name"), 400);

      try {
        if (toolName === "oura_personal_info") {
          return await handleSingletonTool(id, toolName, env.OURA_API_TOKEN, env.DB, ctx);
        }
        if (toolName === "oura_heart_rate") {
          return await handleHeartRateTool(id, toolArgs, env.OURA_API_TOKEN);
        }
        if (DATE_KEYED_TOOLS.has(toolName)) {
          return await handleDateRangeTool(id, toolName, toolArgs, env.OURA_API_TOKEN, env.DB, ctx);
        }
        throw new Error(`Unknown tool: ${toolName}`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return jsonResponse(ok(id, {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        }));
      }
    }

    case "ping":
      return jsonResponse(ok(id, {}));

    default:
      return jsonResponse(err(id, -32601, `Method not found: ${method}`), 404);
  }
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const { pathname } = new URL(request.url);

    if (pathname === "/mcp/sleep") {
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
      return handleMcp(request, env, ctx, SLEEP_TOOLS, "oura-sleep-recovery");
    }

    if (pathname === "/mcp/activity") {
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
      return handleMcp(request, env, ctx, ACTIVITY_TOOLS, "oura-activity-wellness");
    }

    if (pathname === "/" || pathname === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        server: "oura-mcp-server",
        version: "1.0.0",
        endpoints: { sleep: "/mcp/sleep", activity: "/mcp/activity" },
      }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
