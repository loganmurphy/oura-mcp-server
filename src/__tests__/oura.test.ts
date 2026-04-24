import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getDailySleep,
  getSleepSessions,
  getDailyReadiness,
  getDailyActivity,
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
    await expect(getDailySleep(TOKEN)).rejects.toThrow("Personal Access Token has likely expired");
  });

  it("throws with PAT rotation message on 403", async () => {
    mockFetch(403, { error: "forbidden" });
    await expect(getDailySleep(TOKEN)).rejects.toThrow("npx wrangler secret put OURA_API_TOKEN");
  });

  it("throws a plain error for other non-ok statuses", async () => {
    mockFetch(500, "internal error");
    await expect(getDailySleep(TOKEN)).rejects.toThrow("Oura API error 500");
  });
});

// ── Correct URLs & auth header ────────────────────────────────────────────────

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

// ── Noise stripping — getDailyActivity ───────────────────────────────────────

describe("getDailyActivity — noise stripping", () => {
  it("removes met and class_5_min from each item", async () => {
    mockFetch(200, {
      data: [{
        day: "2026-04-15",
        score: 70,
        steps: 8000,
        met: { interval: 60, items: [1.1, 1.2, 1.3] },
        class_5_min: "11223",
      }],
      next_token: null,
    });
    const resp = await getDailyActivity(TOKEN, "2026-04-15", "2026-04-15") as { data: Record<string, unknown>[] };
    expect(resp.data[0]).not.toHaveProperty("met");
    expect(resp.data[0]).not.toHaveProperty("class_5_min");
  });

  it("preserves all other fields", async () => {
    mockFetch(200, {
      data: [{ day: "2026-04-15", score: 70, steps: 8000, active_calories: 300 }],
      next_token: null,
    });
    const resp = await getDailyActivity(TOKEN, "2026-04-15", "2026-04-15") as { data: Record<string, unknown>[] };
    expect(resp.data[0]).toMatchObject({ day: "2026-04-15", score: 70, steps: 8000, active_calories: 300 });
  });

  it("handles empty data array without error", async () => {
    mockFetch(200, { data: [], next_token: null });
    const resp = await getDailyActivity(TOKEN) as { data: unknown[] };
    expect(resp.data).toHaveLength(0);
  });
});

// ── Noise stripping — getSleepSessions ───────────────────────────────────────

describe("getSleepSessions — noise stripping", () => {
  it("removes sleep_phase_5_min, sleep_phase_30_sec, app_sleep_phase_5_min, movement_30_sec", async () => {
    mockFetch(200, {
      data: [{
        day: "2026-04-15",
        score: 85,
        sleep_phase_5_min: "444444444444",
        sleep_phase_30_sec: "444444444444",
        app_sleep_phase_5_min: "444444444444",
        movement_30_sec: "111111111111",
      }],
      next_token: null,
    });
    const resp = await getSleepSessions(TOKEN, "2026-04-15", "2026-04-16") as { data: Record<string, unknown>[] };
    expect(resp.data[0]).not.toHaveProperty("sleep_phase_5_min");
    expect(resp.data[0]).not.toHaveProperty("sleep_phase_30_sec");
    expect(resp.data[0]).not.toHaveProperty("app_sleep_phase_5_min");
    expect(resp.data[0]).not.toHaveProperty("movement_30_sec");
  });

  it("removes items arrays from hrv and heart_rate but keeps summary stats", async () => {
    mockFetch(200, {
      data: [{
        day: "2026-04-15",
        hrv: { balance: 92, items: [45, 47, 50, 48] },
        heart_rate: { average: 58, items: [55, 58, 60, 57] },
      }],
      next_token: null,
    });
    const resp = await getSleepSessions(TOKEN, "2026-04-15", "2026-04-16") as { data: Record<string, unknown>[] };
    const item = resp.data[0]!;
    expect((item["hrv"] as Record<string, unknown>)["items"]).toBeUndefined();
    expect((item["hrv"] as Record<string, unknown>)["balance"]).toBe(92);
    expect((item["heart_rate"] as Record<string, unknown>)["items"]).toBeUndefined();
    expect((item["heart_rate"] as Record<string, unknown>)["average"]).toBe(58);
  });

  it("handles missing hrv and heart_rate gracefully", async () => {
    mockFetch(200, {
      data: [{ day: "2026-04-15", score: 85 }],
      next_token: null,
    });
    const resp = await getSleepSessions(TOKEN, "2026-04-15", "2026-04-16") as { data: Record<string, unknown>[] };
    expect(resp.data[0]).toMatchObject({ day: "2026-04-15", score: 85 });
  });

  it("handles empty data array without error", async () => {
    mockFetch(200, { data: [], next_token: null });
    const resp = await getSleepSessions(TOKEN) as { data: unknown[] };
    expect(resp.data).toHaveLength(0);
  });
});
