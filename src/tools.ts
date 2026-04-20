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

/**
 * Sleep & Recovery tools — served at /mcp/sleep
 *
 * Claude Desktop enforces a per-MCP-server tool cap (~5 tools). Splitting into
 * two focused servers keeps each under the limit while grouping tools by domain:
 * sleep quality, recovery, and overnight biometrics belong together here.
 */
export const SLEEP_TOOLS: ToolDef[] = [
  {
    name: "oura_personal_info",
    description: "Get the user's Oura personal info: age, weight, height, biological sex, email.",
    inputSchema: { type: "object", properties: { ...SKIP_CACHE_PROP } },
  },
  {
    name: "oura_daily_sleep",
    description:
      "Get daily sleep summary scores for a date range. Includes overall sleep score and contributors (deep sleep, efficiency, latency, REM, restfulness, timing, total sleep).",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date in YYYY-MM-DD format (default: 7 days ago)" },
        end_date: { type: "string", description: "End date in YYYY-MM-DD format (default: today)" },
        ...SKIP_CACHE_PROP,
      },
    },
  },
  {
    name: "oura_sleep_sessions",
    description:
      "Get detailed sleep sessions including sleep stages (awake, light, deep, REM), HRV, heart rate, breathing, and temperature deviation.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date in YYYY-MM-DD format (default: 7 days ago)" },
        end_date: { type: "string", description: "End date in YYYY-MM-DD format (default: today)" },
        ...SKIP_CACHE_PROP,
      },
    },
  },
  {
    name: "oura_daily_readiness",
    description:
      "Get daily readiness scores and contributors (activity balance, body temperature, HRV balance, previous day activity, previous night, recovery index, resting heart rate, sleep balance).",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date in YYYY-MM-DD format (default: 7 days ago)" },
        end_date: { type: "string", description: "End date in YYYY-MM-DD format (default: today)" },
        ...SKIP_CACHE_PROP,
      },
    },
  },
  {
    name: "oura_daily_spo2",
    // SpO2 is measured overnight, making it a natural fit for the sleep/recovery group
    description: "Get daily blood oxygen saturation (SpO2) averages. Measured during sleep — useful for spotting breathing disruptions alongside sleep stage data.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date in YYYY-MM-DD format (default: 7 days ago)" },
        end_date: { type: "string", description: "End date in YYYY-MM-DD format (default: today)" },
        ...SKIP_CACHE_PROP,
      },
    },
  },
];

/**
 * Activity & Wellness tools — served at /mcp/activity
 *
 * Daytime metrics: movement, workouts, continuous heart rate, and stress.
 * Kept separate from sleep/recovery so each server stays within the
 * Claude Desktop tool cap and the domains remain semantically distinct.
 */
export const ACTIVITY_TOOLS: ToolDef[] = [
  {
    name: "oura_daily_activity",
    description:
      "Get daily activity data including activity score, active calories, steps, equivalent walking distance, and sedentary/low/medium/high activity minutes.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date in YYYY-MM-DD format (default: 7 days ago)" },
        end_date: { type: "string", description: "End date in YYYY-MM-DD format (default: today)" },
        ...SKIP_CACHE_PROP,
      },
    },
  },
  {
    name: "oura_heart_rate",
    description:
      "Get continuous heart rate measurements. Returns timestamped BPM readings and the measurement source (awake, sleep, session, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        start_datetime: {
          type: "string",
          description: "Start datetime in ISO 8601 format, e.g. 2024-01-15T00:00:00Z (default: 24h ago)",
        },
        end_datetime: {
          type: "string",
          description: "End datetime in ISO 8601 format (default: now)",
        },
      },
    },
  },
  {
    name: "oura_workouts",
    description:
      "Get workout sessions including activity type, start/end time, calories burned, heart rate stats, and distance.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date in YYYY-MM-DD format (default: 7 days ago)" },
        end_date: { type: "string", description: "End date in YYYY-MM-DD format (default: today)" },
        ...SKIP_CACHE_PROP,
      },
    },
  },
  {
    name: "oura_daily_stress",
    description: "Get daily stress levels and recovery data including daytime stress, recovery, and ruggedness scores.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date in YYYY-MM-DD format (default: 7 days ago)" },
        end_date: { type: "string", description: "End date in YYYY-MM-DD format (default: today)" },
        ...SKIP_CACHE_PROP,
      },
    },
  },
];
