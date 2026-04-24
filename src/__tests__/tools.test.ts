import { describe, it, expect } from "vitest";
import { SLEEP_TOOLS, ACTIVITY_TOOLS, type ToolDef } from "../tools";

const ALL_TOOLS = [...SLEEP_TOOLS, ...ACTIVITY_TOOLS];

const SLEEP_TOOL_NAMES = [
  "oura_daily_sleep",
  "oura_sleep_sessions",
  "oura_daily_readiness",
  "oura_daily_spo2",
];

const ACTIVITY_TOOL_NAMES = [
  "oura_daily_activity",
  "oura_workouts",
  "oura_daily_stress",
];

function hasValidSchema(tool: ToolDef) {
  return (
    tool.inputSchema.type === "object" &&
    typeof tool.inputSchema.properties === "object"
  );
}

describe("SLEEP_TOOLS", () => {
  it("contains exactly the expected 4 tools", () => {
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
  it("contains exactly the expected 3 tools", () => {
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
  it("is present on all tools", () => {
    for (const tool of ALL_TOOLS) {
      expect(
        tool.inputSchema.properties["skip_cache"],
        `${tool.name} missing skip_cache`,
      ).toBeDefined();
    }
  });

  it("has type boolean on all tools", () => {
    for (const tool of ALL_TOOLS) {
      expect(
        tool.inputSchema.properties["skip_cache"]?.type,
        `${tool.name} skip_cache not boolean`,
      ).toBe("boolean");
    }
  });
});

describe("date-range tools", () => {
  it("all tools have start_date and end_date properties", () => {
    for (const tool of ALL_TOOLS) {
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

  it("end_date description mentions inclusive on all tools", () => {
    for (const tool of ALL_TOOLS) {
      const desc = tool.inputSchema.properties["end_date"]?.description ?? "";
      expect(desc, `${tool.name} end_date should mention inclusive`).toContain("inclusive");
    }
  });

  it("non-daily_sleep end_date descriptions note server adds +1 day", () => {
    const exclusiveTools = ALL_TOOLS.filter((t) => t.name !== "oura_daily_sleep");
    for (const tool of exclusiveTools) {
      const desc = tool.inputSchema.properties["end_date"]?.description ?? "";
      expect(desc, `${tool.name} end_date should mention server adds +1 day`).toContain("+1 day");
    }
  });
});
