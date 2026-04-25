export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

// Appended to every cacheable tool so Claude can bypass stale cache on demand.
const SKIP_CACHE_PROP = {
  skip_cache: {
    type: "boolean",
    description: "Set to true to bypass the D1 cache and fetch fresh data directly from Oura. Useful when data hasn't synced yet (e.g. this morning's sleep session).",
  },
} as const;

// Shared date-range schema for tools whose Oura API endpoint uses exclusive end_date.
// The server adds +1 day automatically so callers always use inclusive end_date.
const DATE_RANGE_PROPS = {
  start_date: { type: "string", description: "Start date in YYYY-MM-DD format (default: 7 days ago)" },
  end_date: { type: "string", description: "End date in YYYY-MM-DD format, inclusive (default: today). The server adds +1 day when calling the Oura API, which treats end_date as exclusive." },
  ...SKIP_CACHE_PROP,
} as const;

// Split into two servers because Claude Desktop enforces a per-server tool cap (~5).
export const SLEEP_TOOLS: ToolDef[] = [
  {
    name: "oura_daily_sleep",
    description:
      "Get daily sleep summary scores for a date range. " +
      "The `day` field uses the wake-up date — a sleep starting the night of Apr 23 and ending the morning of Apr 24 has day: '2026-04-24'. " +
      "To get last night's sleep, use today's date for both start_date and end_date with skip_cache: true — the ring may not have synced yet and an empty result does NOT mean no data, it means a fresh fetch is needed. " +
      "end_date is inclusive (this endpoint is the exception — the Oura daily_sleep API is inclusive unlike all others). " +
      "Includes overall sleep score and contributors (deep sleep, efficiency, latency, REM, restfulness, timing, total sleep).",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date in YYYY-MM-DD format (default: 7 days ago)" },
        end_date: { type: "string", description: "End date in YYYY-MM-DD format, inclusive (default: today)" },
        ...SKIP_CACHE_PROP,
      },
    },
  },
  {
    name: "oura_sleep_sessions",
    description:
      "Get detailed sleep sessions including sleep stages (awake, light, deep, REM), HRV, heart rate, breathing, and temperature deviation. " +
      "The `day` field uses the wake-up date — same convention as oura_daily_sleep, so sessions can be joined to scores by the `day` field. " +
      "For last night's sessions, use today's date with skip_cache: true — an empty result for today means the ring hasn't synced yet, not that no session exists. " +
      "end_date is inclusive — the server adds +1 day when calling the Oura API (which treats it as exclusive).",
    inputSchema: {
      type: "object",
      properties: { ...DATE_RANGE_PROPS },
    },
  },
  {
    name: "oura_daily_readiness",
    description:
      "Get daily readiness scores and contributors (activity balance, body temperature, HRV balance, previous day activity, previous night, recovery index, resting heart rate, sleep balance). " +
      "The `day` field uses the wake-up date — same convention as oura_daily_sleep. " +
      "For today's readiness, use today's date with skip_cache: true — an empty result means the ring hasn't synced yet. " +
      "end_date is inclusive — the server adds +1 day when calling the Oura API.",
    inputSchema: {
      type: "object",
      properties: { ...DATE_RANGE_PROPS },
    },
  },
  {
    name: "oura_daily_spo2",
    description:
      "Get daily blood oxygen saturation (SpO2) averages measured during sleep. " +
      "The `day` field uses the wake-up date — same convention as oura_daily_sleep. " +
      "For last night's SpO2, use today's date with skip_cache: true — an empty result means the ring hasn't synced yet. " +
      "Useful for spotting breathing disruptions alongside sleep data. " +
      "end_date is inclusive — the server adds +1 day when calling the Oura API.",
    inputSchema: {
      type: "object",
      properties: { ...DATE_RANGE_PROPS },
    },
  },
];

export const ACTIVITY_TOOLS: ToolDef[] = [
  {
    name: "oura_daily_activity",
    description:
      "Get daily activity data including activity score, active calories, steps, equivalent walking distance, and sedentary/low/medium/high activity minutes. " +
      "The `day` field uses the calendar date of the activity (not the wake-up convention used by sleep/readiness/SpO2). " +
      "end_date is inclusive — the server adds +1 day when calling the Oura API.",
    inputSchema: {
      type: "object",
      properties: { ...DATE_RANGE_PROPS },
    },
  },
  {
    name: "oura_workouts",
    description:
      "Get workout sessions including activity type, start/end time, calories burned, heart rate stats, and distance. " +
      "The `day` field uses the calendar date of the workout. " +
      "end_date is inclusive — the server adds +1 day when calling the Oura API.",
    inputSchema: {
      type: "object",
      properties: { ...DATE_RANGE_PROPS },
    },
  },
  {
    name: "oura_daily_stress",
    description:
      "Get daily stress levels and recovery data including daytime stress, recovery, and ruggedness scores. " +
      "The `day` field uses the calendar date. " +
      "end_date is inclusive — the server adds +1 day when calling the Oura API.",
    inputSchema: {
      type: "object",
      properties: { ...DATE_RANGE_PROPS },
    },
  },
];
