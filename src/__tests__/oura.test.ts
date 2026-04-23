import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPersonalInfo,
  getDailySleep,
  getSleepSessions,
  getDailyReadiness,
  getDailyActivity,
  getHeartRate,
  getDailySpo2,
  getWorkouts,
  getDailyStress,
} from "../oura";

const TOKEN = "test-token";

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ── Auth errors ───────────────────────────────────────────────────────────────

describe("auth errors", () => {
  it("throws with PAT rotation message on 401", async () => {
    mockFetch(401, { error: "unauthorized" });
    await expect(getPersonalInfo(TOKEN)).rejects.toThrow("Personal Access Token has likely expired");
  });

  it("throws with PAT rotation message on 403", async () => {
    mockFetch(403, { error: "forbidden" });
    await expect(getPersonalInfo(TOKEN)).rejects.toThrow("npx wrangler secret put OURA_API_TOKEN");
  });

  it("throws a plain error for other non-ok statuses", async () => {
    mockFetch(500, "internal error");
    await expect(getPersonalInfo(TOKEN)).rejects.toThrow("Oura API error 500");
  });
});

// ── Correct URLs & auth header ────────────────────────────────────────────────

describe("getPersonalInfo", () => {
  it("calls the correct endpoint", async () => {
    const spy = mockFetch(200, { age: 30 });
    await getPersonalInfo(TOKEN);
    expect(spy).toHaveBeenCalledWith(
      "https://api.ouraring.com/v2/usercollection/personal_info",
      expect.objectContaining({ headers: { Authorization: `Bearer ${TOKEN}` } }),
    );
  });
});

describe("getDailySleep", () => {
  it("includes start_date and end_date when provided", async () => {
    const spy = mockFetch(200, { data: [] });
    await getDailySleep(TOKEN, "2026-04-01", "2026-04-07");
    const url = (spy.mock.calls[0]![0] as string);
    expect(url).toContain("start_date=2026-04-01");
    expect(url).toContain("end_date=2026-04-07");
    expect(url).toContain("/daily_sleep");
  });

  it("defaults start_date to 7 days ago when omitted", async () => {
    const spy = mockFetch(200, { data: [] });
    await getDailySleep(TOKEN);
    const url = (spy.mock.calls[0]![0] as string);
    expect(url).toContain("start_date=");
    expect(url).not.toContain("end_date=");
  });
});

describe("getSleepSessions", () => {
  it("calls the sleep endpoint", async () => {
    const spy = mockFetch(200, { data: [] });
    await getSleepSessions(TOKEN, "2026-04-01", "2026-04-07");
    expect(spy.mock.calls[0]![0]).toContain("/sleep?");
  });
});

describe("getDailyReadiness", () => {
  it("calls the daily_readiness endpoint", async () => {
    const spy = mockFetch(200, { data: [] });
    await getDailyReadiness(TOKEN, "2026-04-01", "2026-04-07");
    expect(spy.mock.calls[0]![0]).toContain("/daily_readiness");
  });
});

describe("getDailyActivity", () => {
  it("calls the daily_activity endpoint", async () => {
    const spy = mockFetch(200, { data: [] });
    await getDailyActivity(TOKEN, "2026-04-01", "2026-04-07");
    expect(spy.mock.calls[0]![0]).toContain("/daily_activity");
  });
});

describe("getHeartRate", () => {
  it("calls heart_rate with start_datetime and end_datetime", async () => {
    const spy = mockFetch(200, { data: [] });
    await getHeartRate(TOKEN, "2026-04-01T00:00:00Z", "2026-04-02T00:00:00Z");
    const url = spy.mock.calls[0]![0] as string;
    expect(url).toContain("start_datetime=");
    expect(url).toContain("end_datetime=");
    expect(url).toContain("/heart_rate");
  });

  it("defaults start_datetime to 24h ago when omitted", async () => {
    const spy = mockFetch(200, { data: [] });
    await getHeartRate(TOKEN);
    const url = spy.mock.calls[0]![0] as string;
    expect(url).toContain("start_datetime=");
    expect(url).not.toContain("end_datetime=");
  });
});

describe("getDailySpo2", () => {
  it("calls the daily_spo2 endpoint", async () => {
    const spy = mockFetch(200, { data: [] });
    await getDailySpo2(TOKEN, "2026-04-01", "2026-04-07");
    expect(spy.mock.calls[0]![0]).toContain("/daily_spo2");
  });
});

describe("getWorkouts", () => {
  it("calls the workout endpoint", async () => {
    const spy = mockFetch(200, { data: [] });
    await getWorkouts(TOKEN, "2026-04-01", "2026-04-07");
    expect(spy.mock.calls[0]![0]).toContain("/workout?");
  });
});

describe("getDailyStress", () => {
  it("calls the daily_stress endpoint", async () => {
    const spy = mockFetch(200, { data: [] });
    await getDailyStress(TOKEN, "2026-04-01", "2026-04-07");
    expect(spy.mock.calls[0]![0]).toContain("/daily_stress");
  });
});
