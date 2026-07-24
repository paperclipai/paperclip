import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the raw drivers so the test is deterministic and needs no database.
// Note: only "drizzle-orm/postgres-js" is mocked here, not its "/migrator"
// submodule (a separate specifier), so client.ts still loads cleanly.
vi.mock("postgres", () => ({
  default: vi.fn(() => ({ __fakeSql: true })),
}));
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: vi.fn((client: unknown) => ({ __client: client })),
}));

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { APP_POOL_OPTIONS, createDb } from "./client.js";

const postgresMock = vi.mocked(postgres);
const drizzleMock = vi.mocked(drizzle);

describe("createDb connection-pool resilience (SCR-4)", () => {
  beforeEach(() => {
    postgresMock.mockClear();
    drizzleMock.mockClear();
  });

  it("opens the application pool with connection-recycling options", () => {
    const url = "postgres://user:pass@127.0.0.1:5432/db";
    createDb(url);

    expect(postgresMock).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = postgresMock.mock.calls[0];
    expect(calledUrl).toBe(url);
    // Guardrail: without these options a flapped/half-open pooled connection
    // lingers and surfaces intermittent, non-retryable transaction 500s (SCR-4).
    expect(options).toMatchObject(APP_POOL_OPTIONS);
  });

  it("recycles idle and long-lived connections via positive timeouts", () => {
    expect(APP_POOL_OPTIONS.connect_timeout).toBeGreaterThan(0);
    expect(APP_POOL_OPTIONS.idle_timeout).toBeGreaterThan(0);
    expect(APP_POOL_OPTIONS.max_lifetime).toBeGreaterThan(0);
  });
});
