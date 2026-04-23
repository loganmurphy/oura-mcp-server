import { describe, it, expect } from "vitest";
import { SLEEP_TOOLS, ACTIVITY_TOOLS, type ToolDef } from "../tools";

const ALL_TOOLS = [...SLEEP_TOOLS, ...ACTIVITY_TOOLS];

const SLEEP_TOOL_NAMES = [
  "oura_personal_info",
  "oura_daily_sleep",
  "oura_sleep_sessions",
  "oura_daily_readiness",
  "oura_daily_spo2",
];

const ACTIVITY_TOOL_NAMES = [
  "oura_daily_activity",
  "oura_heart_rate",
  "oura_workouts",
  "oura_daily_stress",
];

// Tools that accept date ranges and expose skip_cache
const CACHEABLE_TOOLS = ALL_TOOLS.filter((t) => t.name !== "oura_heart_rate");

function hasValidSchema(tool: ToolDef) {
  return (
    tool.inputSchema.type === "object" &&
    typeof tool.inputSchema.properties === "object"
  );
}

describe("SLEEP_TOOLS", () => {
  it("contains exactly the expected 5 tools", () => {
    expect(SLEEP_TOOLS.map((t) => t.name)).toEqual(SLEEP_TOOL_NAMES);
  });

  it("every tool has a non-empty description", () => {
    for (const tool of SLEEP_TOOLS) {
      expect(tool.description.length, `${tool.name} missing description`).toBeGreaterThan(0);
    }
  });

  it("every tool has a valid input schema", () => {
    for (const tool of SLEEP_TOOLS) {
      expect(hasValidSchema(tool), `${tool.name} invalid schema`).toBe(true);
    }
  });
});

describe("ACTIVITY_TOOLS", () => {
  it("contains exactly the expected 4 tools", () => {
    expect(ACTIVITY_TOOLS.map((t) => t.name)).toEqual(ACTIVITY_TOOL_NAMES);
  });

  it("every tool has a non-empty description", () => {
    for (const tool of ACTIVITY_TOOLS) {
      expect(tool.description.length, `${tool.name} missing description`).toBeGreaterThan(0);
    }
  });

  it("every tool has a valid input schema", () => {
    for (const tool of ACTIVITY_TOOLS) {
      expect(hasValidSchema(tool), `${tool.name} invalid schema`).toBe(true);
    }
  });
});

describe("skip_cache property", () => {
  it("is present on all cacheable tools", () => {
    for (const tool of CACHEABLE_TOOLS) {
      expect(
        tool.inputSchema.properties["skip_cache"],
        `${tool.name} missing skip_cache`,
      ).toBeDefined();
    }
  });

  it("is absent on oura_heart_rate (not date-keyed)", () => {
    const heartRate = ACTIVITY_TOOLS.find((t) => t.name === "oura_heart_rate")!;
    expect(heartRate.inputSchema.properties["skip_cache"]).toBeUndefined();
  });

  it("has type boolean on all cacheable tools", () => {
    for (const tool of CACHEABLE_TOOLS) {
      expect(
        tool.inputSchema.properties["skip_cache"]?.type,
        `${tool.name} skip_cache not boolean`,
      ).toBe("boolean");
    }
  });
});

describe("date-range tools", () => {
  const dateRangeTools = ALL_TOOLS.filter(
    (t) => t.name !== "oura_personal_info" && t.name !== "oura_heart_rate",
  );

  it("all have start_date and end_date properties", () => {
    for (const tool of dateRangeTools) {
      expect(
        tool.inputSchema.properties["start_date"],
        `${tool.name} missing start_date`,
      ).toBeDefined();
      expect(
        tool.inputSchema.properties["end_date"],
        `${tool.name} missing end_date`,
      ).toBeDefined();
    }
  });
});

describe("oura_heart_rate", () => {
  const tool = ACTIVITY_TOOLS.find((t) => t.name === "oura_heart_rate")!;

  it("has start_datetime and end_datetime instead of date params", () => {
    expect(tool.inputSchema.properties["start_datetime"]).toBeDefined();
    expect(tool.inputSchema.properties["end_datetime"]).toBeDefined();
    expect(tool.inputSchema.properties["start_date"]).toBeUndefined();
  });
});
