import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultClientContext,
  readContext,
  setCurrentProfile,
  upsertProfile,
  writeContext,
} from "../client/context.js";

function createTempContextPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ironworks-cli-context-"));
  return path.join(dir, "context.json");
}

describe("client context store", () => {
  it("returns default context when file does not exist", () => {
    const contextPath = createTempContextPath();
    const context = readContext(contextPath);
    expect(context).toEqual(defaultClientContext());
  });

  it("upserts profile values and switches current profile", () => {
    const contextPath = createTempContextPath();

    upsertProfile(
      "work",
      {
        apiBase: "http://localhost:3100",
        companyId: "company-123",
        apiKeyEnvVarName: "IRONWORKS_AGENT_TOKEN",
      },
      contextPath,
    );

    setCurrentProfile("work", contextPath);
    const context = readContext(contextPath);

    expect(context.currentProfile).toBe("work");
    expect(context.profiles.work).toEqual({
      apiBase: "http://localhost:3100",
      companyId: "company-123",
      apiKeyEnvVarName: "IRONWORKS_AGENT_TOKEN",
    });
  });

  it("normalizes invalid file content to safe defaults", () => {
    const contextPath = createTempContextPath();
    writeContext(
      {
        version: 1,
        currentProfile: "x",
        profiles: {
          x: {
            apiBase: " ",
            companyId: " ",
            apiKeyEnvVarName: " ",
          },
        },
      },
      contextPath,
    );

    const context = readContext(contextPath);
    expect(context.currentProfile).toBe("x");
    expect(context.profiles.x).toEqual({});
  });
});
