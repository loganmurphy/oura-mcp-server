const OURA_BASE = "https://api.ouraring.com";

function dateRange(startDate?: string, endDate?: string) {
  const params = new URLSearchParams();
  if (startDate) params.set("start_date", startDate);
  if (endDate) params.set("end_date", endDate);
  if (!startDate) {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    params.set("start_date", d.toISOString().slice(0, 10));
  }
  return params;
}

async function ouraget(token: string, path: string, params: URLSearchParams) {
  const qs = params.toString();
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

export async function getPersonalInfo(token: string) {
  return ouraget(token, "/v2/usercollection/personal_info", new URLSearchParams());
}

export async function getDailySleep(token: string, startDate?: string, endDate?: string) {
  return ouraget(token, "/v2/usercollection/daily_sleep", dateRange(startDate, endDate));
}

export async function getSleepSessions(token: string, startDate?: string, endDate?: string) {
  return ouraget(token, "/v2/usercollection/sleep", dateRange(startDate, endDate));
}

export async function getDailyReadiness(token: string, startDate?: string, endDate?: string) {
  return ouraget(token, "/v2/usercollection/daily_readiness", dateRange(startDate, endDate));
}

export async function getDailyActivity(token: string, startDate?: string, endDate?: string) {
  return ouraget(token, "/v2/usercollection/daily_activity", dateRange(startDate, endDate));
}

export async function getHeartRate(token: string, startDatetime?: string, endDatetime?: string) {
  const params = new URLSearchParams();
  if (startDatetime) {
    params.set("start_datetime", startDatetime);
  } else {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    params.set("start_datetime", d.toISOString());
  }
  if (endDatetime) params.set("end_datetime", endDatetime);
  return ouraget(token, "/v2/usercollection/heart_rate", params);
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
