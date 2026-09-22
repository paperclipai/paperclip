import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_RUN_LIST_DEFAULT_LIMIT,
  HEARTBEAT_RUN_LIST_MAX_LIMIT,
  readRunQueryInt,
} from "./run-query-limits.js";

const readHeartbeatRunListLimit = (value: unknown) =>
  readRunQueryInt(value, HEARTBEAT_RUN_LIST_MAX_LIMIT, HEARTBEAT_RUN_LIST_DEFAULT_LIMIT);

describe("readRunQueryInt", () => {
  it("falls back when the parameter is absent or unusable", () => {
    // The regression this guards: an omitted `limit` used to mean "no limit".
    expect(readHeartbeatRunListLimit(undefined)).toBe(HEARTBEAT_RUN_LIST_DEFAULT_LIMIT);
    expect(readHeartbeatRunListLimit("")).toBe(HEARTBEAT_RUN_LIST_DEFAULT_LIMIT);
    expect(readHeartbeatRunListLimit("not-a-number")).toBe(HEARTBEAT_RUN_LIST_DEFAULT_LIMIT);
    expect(readHeartbeatRunListLimit("0")).toBe(HEARTBEAT_RUN_LIST_DEFAULT_LIMIT);
    expect(readHeartbeatRunListLimit("-25")).toBe(HEARTBEAT_RUN_LIST_DEFAULT_LIMIT);
  });

  it("honours a caller limit up to the ceiling", () => {
    expect(readHeartbeatRunListLimit("5")).toBe(5);
    expect(readHeartbeatRunListLimit("200")).toBe(200);
    expect(readHeartbeatRunListLimit("1000")).toBe(HEARTBEAT_RUN_LIST_MAX_LIMIT);
    expect(readHeartbeatRunListLimit("5000")).toBe(HEARTBEAT_RUN_LIST_MAX_LIMIT);
    expect(readHeartbeatRunListLimit("12.9")).toBe(12);
  });

  it("keeps a zero fallback available for padding floors", () => {
    expect(readRunQueryInt(undefined, 50, 0)).toBe(0);
    expect(readRunQueryInt("80", 50, 0)).toBe(50);
  });
});
