import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the postgres client and the drizzle adapter so we can assert the options
// `createDb` passes without opening a real connection. `vi.hoisted` keeps the
// mock fns available to the hoisted `vi.mock` factories.
const { postgresMock, drizzleMock } = vi.hoisted(() => ({
  postgresMock: vi.fn((_url: string, _options?: Record<string, unknown>) => ({
    __fakeSql: true,
  })),
  drizzleMock: vi.fn((client: unknown) => ({ __fakeDrizzle: true, client })),
}));

vi.mock("postgres", () => ({ default: postgresMock }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: drizzleMock }));

import { createDb } from "./client.js";

describe("createDb prepared-statement safety (#8148)", () => {
  beforeEach(() => {
    postgresMock.mockClear();
    drizzleMock.mockClear();
  });

  it("passes { prepare: false } to postgres so named prepared statements are disabled", () => {
    // Regression guard: with prepared statements enabled, postgres@3.4.x can
    // crash in its ParameterDescription -> Bind path when a Date parameter
    // reaches Buffer.byteLength (observed as a 500 on the comment-delta query).
    // Disabling prepare avoids that path; this asserts the flag stays set.
    const url = "postgres://user:pass@localhost:5432/paperclip";

    createDb(url);

    expect(postgresMock).toHaveBeenCalledTimes(1);
    const [passedUrl, options] = postgresMock.mock.calls[0];
    expect(passedUrl).toBe(url);
    expect(options).toMatchObject({ prepare: false });
  });
});
