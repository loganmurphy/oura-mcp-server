const OURA_BASE = "https://api.ouraring.com"

type OuraItem = Record<string, unknown>

function dateRange(startDate?: string, endDate?: string) {
  if (!startDate) {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    startDate = d.toISOString().slice(0, 10)
  }
  const params = new URLSearchParams({ start_date: startDate })
  if (endDate) params.set("end_date", endDate)
  return params
}

const MAX_RETRIES = 2

// Retries up to MAX_RETRIES times on transient failures.
// 429 → respects Retry-After header (capped at 60 s); 5xx → exponential backoff (1 s, 2 s).
// 401/403 and other 4xx throw immediately without retrying.
async function ouraget(token: string, path: string, params: URLSearchParams): Promise<unknown> {
  const qs = params.toString()
  // v8 ignore next -- buildParams always adds start_date so qs is never empty in practice
  const url = `${OURA_BASE}${path}${qs ? "?" + qs : ""}`

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })

    if (res.ok) return res.json()

    const text = await res.text()

    // PATs expire every ~3 months — surface a fix-it message rather than a bare 401.
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Oura rejected the token (${res.status}). Your Personal Access Token has likely expired or been revoked — PATs expire every ~3 months.\n\n` +
          `Fix: generate a new PAT at https://cloud.ouraring.com/personal-access-tokens and rotate it with:\n    npx wrangler secret put OURA_API_TOKEN`,
      )
    }

    // Retry on 429 (rate limited) and transient 5xx errors.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const delayMs =
        res.status === 429
          ? Math.min(parseInt(res.headers.get("Retry-After") ?? "60", 10) * 1_000, 60_000)
          : 1_000 * 2 ** attempt // 1s, 2s
      await new Promise<void>((r) => setTimeout(r, delayMs))
      continue
    }

    throw new Error(`Oura API error ${res.status}: ${text}`)
  }

  // v8 ignore next -- loop always returns or throws before this
  throw new Error("Oura API request failed after retries")
}

// Strip raw time-series arrays (met.items, class_5_min, sleep_phase_*, etc.)
// before caching — they're large (thousands of tokens) and not useful for LLMs.

function stripActivityNoise(item: OuraItem): OuraItem {
  const result = { ...item }
  delete result["met"]
  delete result["class_5_min"]
  return result
}

function dropItemsArray(nested: unknown): unknown {
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    const copy = { ...(nested as OuraItem) }
    delete copy["items"]
    return copy
  }
  return nested
}

function stripSleepNoise(item: OuraItem): OuraItem {
  const result = { ...item }
  delete result["sleep_phase_5_min"]
  delete result["sleep_phase_30_sec"]
  delete result["app_sleep_phase_5_min"]
  delete result["movement_30_sec"]
  result["hrv"] = dropItemsArray(result["hrv"])
  result["heart_rate"] = dropItemsArray(result["heart_rate"])
  return result
}

export async function getDailySleep(token: string, startDate?: string, endDate?: string) {
  return ouraget(token, "/v2/usercollection/daily_sleep", dateRange(startDate, endDate))
}

export async function getSleepSessions(token: string, startDate?: string, endDate?: string) {
  const resp = (await ouraget(
    token,
    "/v2/usercollection/sleep",
    dateRange(startDate, endDate),
  )) as { data: OuraItem[]; next_token: string | null }
  return { ...resp, data: resp.data.map(stripSleepNoise) }
}

export async function getDailyReadiness(token: string, startDate?: string, endDate?: string) {
  return ouraget(token, "/v2/usercollection/daily_readiness", dateRange(startDate, endDate))
}

export async function getDailyActivity(token: string, startDate?: string, endDate?: string) {
  const resp = (await ouraget(
    token,
    "/v2/usercollection/daily_activity",
    dateRange(startDate, endDate),
  )) as { data: OuraItem[]; next_token: string | null }
  return { ...resp, data: resp.data.map(stripActivityNoise) }
}

export async function getDailySpo2(token: string, startDate?: string, endDate?: string) {
  return ouraget(token, "/v2/usercollection/daily_spo2", dateRange(startDate, endDate))
}

export async function getWorkouts(token: string, startDate?: string, endDate?: string) {
  return ouraget(token, "/v2/usercollection/workout", dateRange(startDate, endDate))
}

export async function getDailyStress(token: string, startDate?: string, endDate?: string) {
  return ouraget(token, "/v2/usercollection/daily_stress", dateRange(startDate, endDate))
}
