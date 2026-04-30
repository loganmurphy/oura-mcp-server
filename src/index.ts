import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider"
import { WorkerEntrypoint } from "cloudflare:workers"
import {
  getDailyActivity,
  getDailyCycleInsights,
  getDailyPerimenopauseHealth,
  getDailyReadiness,
  getDailyReproductiveHealth,
  getDailySleep,
  getDailySpo2,
  getDailyStress,
  getSleepSessions,
  getWorkouts,
} from "./oura"
import { datesInRange, defaultEnd, defaultStart, getCachedRange, setCachedRange } from "./cache"
import { OURA_TOOLS, WOMENS_HEALTH_TOOLS, type ToolDef } from "./tools"
import { renderLoginPage, renderSuccessPage } from "./ui"

export interface Env extends Cloudflare.Env {
  // Injected by OAuthProvider at request time:
  OAUTH_PROVIDER: OAuthHelpers
  ENABLE_WOMENS_HEALTH: string
}

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: string | number | null
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result }
}

function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
}

// Applied to all HTML responses (login + success pages).
// frame-src * is required — the success page fires the OAuth callback in a hidden
// iframe whose src is the client's redirect_uri (unknown at serve time).
const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-src *",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  })
}

type DateArgs = { start_date?: string; end_date?: string }

// Empirically verified: the Oura daily_sleep endpoint treats end_date as inclusive,
// but every other date-range endpoint treats it as exclusive. Add one day to end_date
// for all endpoints except daily_sleep so callers can use a consistent inclusive
// convention across all tools.
function addOneDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function exclusiveEnd(endDate: string | undefined): string {
  return addOneDay(endDate ?? defaultEnd())
}

async function fetchFromOura(
  name: string,
  args: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const d = args as DateArgs

  switch (name) {
    // daily_sleep end_date is inclusive — pass through as-is
    case "oura_daily_sleep":
      return getDailySleep(token, d.start_date, d.end_date)
    // all other date-range endpoints treat end_date as exclusive — add one day
    case "oura_sleep_sessions":
      return getSleepSessions(token, d.start_date, exclusiveEnd(d.end_date))
    case "oura_daily_readiness":
      return getDailyReadiness(token, d.start_date, exclusiveEnd(d.end_date))
    case "oura_daily_activity":
      return getDailyActivity(token, d.start_date, exclusiveEnd(d.end_date))
    case "oura_daily_spo2":
      return getDailySpo2(token, d.start_date, exclusiveEnd(d.end_date))
    case "oura_workouts":
      return getWorkouts(token, d.start_date, exclusiveEnd(d.end_date))
    case "oura_daily_stress":
      return getDailyStress(token, d.start_date, exclusiveEnd(d.end_date))
    case "oura_cycle_insights":
      return getDailyCycleInsights(token, d.start_date, exclusiveEnd(d.end_date))
    case "oura_reproductive_health":
      return getDailyReproductiveHealth(token, d.start_date, exclusiveEnd(d.end_date))
    case "oura_perimenopause_health":
      return getDailyPerimenopauseHealth(token, d.start_date, exclusiveEnd(d.end_date))
    // v8 ignore next -- defensive dead code: DATE_KEYED_TOOLS guard prevents reaching here
    default:
      throw new Error(`Unknown tool: ${name}`)
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
  "oura_cycle_insights",
  "oura_reproductive_health",
  "oura_perimenopause_health",
])

// Some endpoints return multiple items per day (e.g. nap + main sleep);
// we collapse them into one cache row per day.
function groupByDay(items: Array<{ day: string } & Record<string, unknown>>) {
  const map = new Map<string, unknown>()
  for (const item of items) {
    const existing = map.get(item.day)
    if (existing === undefined) {
      map.set(item.day, item)
    } else {
      map.set(item.day, Array.isArray(existing) ? [...existing, item] : [existing, item])
    }
  }
  return map
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
  const start = (args["start_date"] as string | undefined) ?? defaultStart()
  const end = (args["end_date"] as string | undefined) ?? defaultEnd()
  const dates = datesInRange(start, end)
  const metric = toolName.replace("oura_", "")

  const cache = skipCache
    ? { hits: new Map<string, unknown>(), misses: dates }
    : await getCachedRange(db, metric, dates)

  if (cache.misses.length === 0) {
    const items = dates.flatMap((d) => {
      const v = cache.hits.get(d)
      return v === undefined ? [] : Array.isArray(v) ? v : [v]
    })
    return jsonResponse(
      ok(id, {
        content: [{ type: "text", text: JSON.stringify({ data: items, _cache: "hit" }, null, 2) }],
      }),
    )
  }

  // Fetch only the span covering missing dates, then merge with cache hits.
  const missStart = cache.misses[0]!
  const missEnd = cache.misses[cache.misses.length - 1]!
  const freshResp = (await fetchFromOura(
    toolName,
    { start_date: missStart, end_date: missEnd },
    token,
  )) as { data: Array<{ day: string } & Record<string, unknown>> }

  const freshByDay = groupByDay(freshResp.data)
  const allItems = dates.flatMap((d) => {
    const v = cache.hits.get(d) ?? freshByDay.get(d)
    return v === undefined ? [] : Array.isArray(v) ? v : [v]
  })

  // Empty Oura responses usually mean "not synced yet" — don't cache them or
  // we serve stale emptiness until the TTL expires.
  const toCache = [...freshByDay.entries()].map(([dateKey, data]) => ({ dateKey, data }))
  if (toCache.length > 0 && !skipCache) {
    ctx.waitUntil(setCachedRange(db, metric, toCache))
  }

  return jsonResponse(
    ok(id, {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              data: allItems,
              _cache: "miss",
            },
            null,
            2,
          ),
        },
      ],
    }),
  )
}

export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  tools: ToolDef[],
  serverName: string,
  forceSkipCache = false,
): Promise<Response> {
  if (!env.OURA_API_TOKEN) {
    return jsonResponse(err(null, -32603, "OURA_API_TOKEN secret not configured"), 500)
  }

  let body: JsonRpcRequest
  try {
    body = (await request.json()) as JsonRpcRequest
  } catch {
    return jsonResponse(err(null, -32700, "Parse error"), 400)
  }

  const { id, method, params = {} } = body

  if (id === undefined && method.startsWith("notifications/")) {
    return new Response(null, { status: 202 })
  }

  switch (method) {
    case "initialize":
      return jsonResponse(
        ok(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: "1.0.0" },
        }),
      )

    case "tools/list":
      return jsonResponse(ok(id, { tools }))

    case "tools/call": {
      const toolName = params["name"] as string
      const toolArgs = (params["arguments"] as Record<string, unknown>) ?? {}
      if (!toolName) return jsonResponse(err(id, -32602, "Missing tool name"), 400)

      try {
        const skipCache = forceSkipCache || toolArgs["skip_cache"] === true
        if (DATE_KEYED_TOOLS.has(toolName)) {
          return await handleDateRangeTool(
            id,
            toolName,
            toolArgs,
            env.OURA_API_TOKEN,
            env.DB,
            ctx,
            skipCache,
          )
        }
        throw new Error(`Unknown tool: ${toolName}`)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return jsonResponse(
          ok(id, {
            content: [{ type: "text", text: `Error: ${message}` }],
            isError: true,
          }),
        )
      }
    }

    case "ping":
      return jsonResponse(ok(id, {}))

    default:
      return jsonResponse(err(id, -32601, `Method not found: ${method}`), 404)
  }
}

class McpApiHandler extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    // v8 ignore next 3 -- OAuthProvider handles CORS before reaching this handler
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS })
    }
    // v8 ignore next -- OAuthProvider rejects non-POST /mcp before reaching this handler
    if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)
    const noCache = new URL(request.url).searchParams.has("no_cache")
    const tools =
      this.env.ENABLE_WOMENS_HEALTH === "true"
        ? [...OURA_TOOLS, ...WOMENS_HEALTH_TOOLS]
        : OURA_TOOLS
    return handleMcp(request, this.env, this.ctx, tools, "oura-mcp-server", noCache)
  }
}

export const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS })
    }

    const url = new URL(request.url)

    if (url.pathname === "/authorize") {
      if (request.method === "GET") {
        // Validate the OAuth request params; throw → 400.
        // Raw query string is embedded in the form so POST can reconstruct it.
        try {
          await env.OAUTH_PROVIDER.parseAuthRequest(request)
        } catch {
          return new Response("Invalid authorization request", { status: 400 })
        }
        return new Response(renderLoginPage(url.search, false), { headers: HTML_HEADERS })
      }

      if (request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") ?? "global"
        const { success } = env.RATE_LIMITER
          ? await env.RATE_LIMITER.limit({ key: ip })
          : { success: true }
        if (!success) {
          return new Response(renderLoginPage("", false, true), {
            status: 429,
            headers: { ...HTML_HEADERS, "Retry-After": "60" },
          })
        }

        let formData: FormData
        try {
          formData = await request.formData()
        } catch {
          return new Response("Invalid form submission", { status: 400 })
        }

        const password = formData.get("password") as string | null
        const rawParams = formData.get("oauth_params") as string | null

        if (!rawParams) {
          return new Response("Missing OAuth parameters", { status: 400 })
        }

        // Reconstruct the original OAuth authorization request from the hidden field
        const reconstructedRequest = new Request(url.origin + "/authorize" + rawParams, {
          method: "GET",
          headers: request.headers,
        })

        let oauthReq
        try {
          oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(reconstructedRequest)
        } catch {
          return new Response("Invalid authorization request", { status: 400 })
        }

        if (!password || password !== env.MCP_AUTH_PASSWORD) {
          return new Response(renderLoginPage(rawParams, true), {
            status: 401,
            headers: HTML_HEADERS,
          })
        }

        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReq,
          userId: "owner",
          metadata: { authorizedAt: new Date().toISOString() },
          scope: oauthReq.scope,
          props: {},
        })
        return new Response(renderSuccessPage(redirectTo), { headers: HTML_HEADERS })
      }

      return new Response("Method not allowed", { status: 405 })
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          server: "oura-mcp-server",
          version: "1.0.0",
          endpoint: "/mcp",
        }),
        { headers: { "Content-Type": "application/json" } },
      )
    }

    return new Response("Not found", { status: 404 })
  },
}

const oauthProvider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  // 30-day access tokens — long-lived for a single-user personal tool
  accessTokenTTL: 3600 * 24 * 30,
  // Refresh tokens never expire — re-auth only needed if explicitly revoked
})

// Rewrite http:// → https:// when X-Forwarded-Proto: https is set.
// OAuthProvider builds discovery/issuer URLs from request.url; without this,
// ngrok and similar proxies cause the discovery document to advertise http://
// endpoints, which OAuth clients reject.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.headers.get("x-forwarded-proto") === "https" && request.url.startsWith("http://")) {
      request = new Request(request.url.replace(/^http:\/\//, "https://"), request)
    }
    return oauthProvider.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<Env>
