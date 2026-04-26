const OURA_BASE = "https://api.ouraring.com";

type OuraItem = Record<string, unknown>;

function dateRange(startDate?: string, endDate?: string) {
  if (!startDate) {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    startDate = d.toISOString().slice(0, 10);
  }
  const params = new URLSearchParams({ start_date: startDate });
  if (endDate) params.set("end_date", endDate);
  return params;
}

async function ouraget(token: string, path: string, params: URLSearchParams) {
  const qs = params.toString();
  // v8 ignore next -- buildParams always adds start_date so qs is never empty in practice
  const url = `${OURA_BASE}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    // PATs expire every ~3 months — surface a fix-it message rather than a bare 401.
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Oura rejected the token (${res.status}). Your Personal Access Token has likely expired or been revoked — PATs expire every ~3 months.\n\n` +
        `Fix: generate a new PAT at https://cloud.ouraring.com/personal-access-tokens and rotate it with:\n    npx wrangler secret put OURA_API_TOKEN`,
      );
    }
    throw new Error(`Oura API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Response noise stripping ──────────────────────────────────────────────────
//
// Several Oura endpoints include raw per-minute/per-5-min time-series arrays
// that are not useful for LLM conversations but are large enough to overflow
// the context window (e.g. met.items ≈ 1 440 floats per day, class_5_min ≈
// 288 chars per day). Strip them before caching or returning.

function stripActivityNoise(item: OuraItem): OuraItem {
  const result = { ...item };
  delete result["met"];
  delete result["class_5_min"];
  return result;
}

function dropItemsArray(nested: unknown): unknown {
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    const copy = { ...(nested as OuraItem) };
    delete copy["items"];
    return copy;
  }
  return nested;
}

function stripSleepNoise(item: OuraItem): OuraItem {
  const result = { ...item };
  // Remove raw per-5-min/30-sec time-series strings — these are large encoded
  // arrays that add thousands of tokens without aiding LLM analysis.
  delete result["sleep_phase_5_min"];
  delete result["sleep_phase_30_sec"];
  delete result["app_sleep_phase_5_min"];
  delete result["movement_30_sec"];
  // Keep hrv/heart_rate summary stats but drop the items arrays
  result["hrv"] = dropItemsArray(result["hrv"]);
  result["heart_rate"] = dropItemsArray(result["heart_rate"]);
  return result;
}

// ── API functions ─────────────────────────────────────────────────────────────

export async function getDailySleep(token: string, startDate?: string, endDate?: string) {
  return ouraget(token, "/v2/usercollection/daily_sleep", dateRange(startDate, endDate));
}

export async function getSleepSessions(token: string, startDate?: string, endDate?: string) {
  const resp = await ouraget(token, "/v2/usercollection/sleep", dateRange(startDate, endDate)) as
    { data: OuraItem[]; next_token: string | null };
  return { ...resp, data: resp.data.map(stripSleepNoise) };
}

export async function getDailyReadiness(token: string, startDate?: string, endDate?: string) {
  return ouraget(token, "/v2/usercollection/daily_readiness", dateRange(startDate, endDate));
}

export async function getDailyActivity(token: string, startDate?: string, endDate?: string) {
  const resp = await ouraget(token, "/v2/usercollection/daily_activity", dateRange(startDate, endDate)) as
    { data: OuraItem[]; next_token: string | null };
  return { ...resp, data: resp.data.map(stripActivityNoise) };
}

export async function getDailySpo2(token: string, startDate?: string, endDate?: string) {
  return ouraget(token, "/v2/usercollection/daily_spo2", dateRange(startDate, endDate));
}

export async function getWorkouts(token: string, startDate?: string, endDate?: string) {
  return ouraget(token, "/v2/usercollection/workout", dateRange(startDate, endDate));
}

export async function getDailyStress(token: string, startDate?: string, endDate?: string) {
  return ouraget(token, "/v2/usercollection/daily_stress", dateRange(startDate, endDate));
}
