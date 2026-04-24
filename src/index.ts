import {
  getDailyActivity,
  getDailyReadiness,
  getDailySleep,
  getDailySpo2,
  getDailyStress,
  getSleepSessions,
  getWorkouts,
} from "./oura";
import {
  datesInRange,
  defaultEnd,
  defaultStart,
  getCachedRange,
  setCachedRange,
} from "./cache";
import { ACTIVITY_TOOLS, SLEEP_TOOLS, type ToolDef } from "./tools";

export interface Env {
  OURA_API_TOKEN: string;
  DB: D1Database;
}

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

type DateArgs = { start_date?: string; end_date?: string };

// Empirically verified: the Oura daily_sleep endpoint treats end_date as inclusive,
// but every other date-range endpoint treats it as exclusive. Add one day to end_date
// for all endpoints except daily_sleep so callers can use a consistent inclusive
// convention across all tools.
function addOneDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function exclusiveEnd(endDate: string | undefined): string {
  return addOneDay(endDate ?? defaultEnd());
}

async function fetchFromOura(
  name: string,
  args: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const d = args as DateArgs;

  switch (name) {
    // daily_sleep end_date is inclusive — pass through as-is
    case "oura_daily_sleep":      return getDailySleep(token, d.start_date, d.end_date);
    // all other date-range endpoints treat end_date as exclusive — add one day
    case "oura_sleep_sessions":   return getSleepSessions(token, d.start_date, exclusiveEnd(d.end_date));
    case "oura_daily_readiness":  return getDailyReadiness(token, d.start_date, exclusiveEnd(d.end_date));
    case "oura_daily_activity":   return getDailyActivity(token, d.start_date, exclusiveEnd(d.end_date));
    case "oura_daily_spo2":       return getDailySpo2(token, d.start_date, exclusiveEnd(d.end_date));
    case "oura_workouts":         return getWorkouts(token, d.start_date, exclusiveEnd(d.end_date));
    case "oura_daily_stress":     return getDailyStress(token, d.start_date, exclusiveEnd(d.end_date));
    default:                      throw new Error(`Unknown tool: ${name}`);
  }
}

/** All tools use per-day cacheable items (response.data[].day field). */
const DATE_KEYED_TOOLS = new Set([
  "oura_daily_sleep",
  "oura_sleep_sessions",
  "oura_daily_readiness",
  "oura_daily_activity",
  "oura_daily_spo2",
  "oura_workouts",
  "oura_daily_stress",
]);

// Some endpoints return multiple items per day (e.g. nap + main sleep);
// we collapse them into one cache row per day.
function groupByDay(items: Array<{ day: string } & Record<string, unknown>>) {
  const map = new Map<string, unknown>();
  for (const item of items) {
    const existing = map.get(item.day);
    if (existing === undefined) {
      map.set(item.day, item);
    } else {
      map.set(item.day, Array.isArray(existing) ? [...existing, item] : [existing, item]);
    }
  }
  return map;
}

async function handleDateRangeTool(
  id: string | number | null,
  toolName: string,
  args: Record<string, unknown>,
  token: string,
  db: D1Database,
  ctx: ExecutionContext,
  skipCache = false,
): Promise<Response> {
  const start = (args["start_date"] as string | undefined) ?? defaultStart();
  const end   = (args["end_date"]   as string | undefined) ?? defaultEnd();
  const dates = datesInRange(start, end);
  const metric = toolName.replace("oura_", "");

  const cache = skipCache
    ? { hits: new Map<string, unknown>(), misses: dates }
    : await getCachedRange(db, metric, dates);

  if (cache.misses.length === 0) {
    const items = dates.flatMap((d) => {
      const v = cache.hits.get(d);
      return v === undefined ? [] : Array.isArray(v) ? v : [v];
    });
    return jsonResponse(ok(id, {
      content: [{ type: "text", text: JSON.stringify({ data: items, _cache: "hit" }, null, 2) }],
    }));
  }

  // Fetch only the span covering missing dates, then merge with cache hits.
  const missStart = cache.misses[0]!;
  const missEnd   = cache.misses[cache.misses.length - 1]!;
  const freshResp = (await fetchFromOura(toolName, { start_date: missStart, end_date: missEnd }, token)) as
    { data: Array<{ day: string } & Record<string, unknown>> };

  const freshByDay = groupByDay(freshResp.data);
  const allItems = dates.flatMap((d) => {
    const v = cache.hits.get(d) ?? freshByDay.get(d);
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
  });

  // Empty Oura responses usually mean "not synced yet" — don't cache them or
  // we serve stale emptiness until the TTL expires.
  const toCache = [...freshByDay.entries()].map(([dateKey, data]) => ({ dateKey, data }));
  if (toCache.length > 0 && !skipCache) {
    ctx.waitUntil(setCachedRange(db, metric, toCache));
  }

  return jsonResponse(ok(id, {
    content: [{ type: "text", text: JSON.stringify({
      data:   allItems,
      _cache: "miss",
    }, null, 2) }],
  }));
}

async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  tools: ToolDef[],
  serverName: string,
  forceSkipCache = false,
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
        const skipCache = forceSkipCache || toolArgs["skip_cache"] === true;
        if (DATE_KEYED_TOOLS.has(toolName)) {
          return await handleDateRangeTool(id, toolName, toolArgs, env.OURA_API_TOKEN, env.DB, ctx, skipCache);
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const { pathname } = url;
    const noCache = url.searchParams.has("no_cache");

    if (pathname === "/mcp/sleep") {
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
      return handleMcp(request, env, ctx, SLEEP_TOOLS, "oura-sleep-recovery", noCache);
    }

    if (pathname === "/mcp/activity") {
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
      return handleMcp(request, env, ctx, ACTIVITY_TOOLS, "oura-activity-wellness", noCache);
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
