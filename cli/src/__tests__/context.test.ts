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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-context-"));
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
        persona: "agent",
        agentId: "agent-123",
        agentName: "Agent One",
        apiKeyEnvVarName: "PAPERCLIP_AGENT_TOKEN",
      },
      contextPath,
    );

    setCurrentProfile("work", contextPath);
    const context = readContext(contextPath);

    expect(context.currentProfile).toBe("work");
    expect(context.profiles.work).toEqual({
      apiBase: "http://localhost:3100",
      companyId: "company-123",
      persona: "agent",
      agentId: "agent-123",
      agentName: "Agent One",
      apiKeyEnvVarName: "PAPERCLIP_AGENT_TOKEN",
    });
  });

  it("preserves existing profile values when patch fields are undefined", () => {
    const contextPath = createTempContextPath();

    upsertProfile(
      "default",
      {
        apiBase: "http://127.0.0.1:3197",
      },
      contextPath,
    );

    upsertProfile(
      "default",
      {
        apiBase: undefined,
        companyId: "company-123",
        persona: undefined,
      },
      contextPath,
    );

    const context = readContext(contextPath);
    expect(context.profiles.default).toEqual({
      apiBase: "http://127.0.0.1:3197",
      companyId: "company-123",
    });
  });

  it("migrates version 1 context files to version 2 with persona metadata", () => {
    const contextPath = createTempContextPath();
    fs.writeFileSync(
      contextPath,
      JSON.stringify({
        version: 1,
        currentProfile: "legacy",
        profiles: {
          legacy: {
            apiBase: "http://localhost:3101",
            companyId: "company-legacy",
            persona: "board",
            apiKeyEnvVarName: "PAPERCLIP_BOARD_TOKEN",
          },
        },
      }),
    );

    const context = readContext(contextPath);

    expect(context.version).toBe(2);
    expect(context.profiles.legacy).toEqual({
      apiBase: "http://localhost:3101",
      companyId: "company-legacy",
      persona: "board",
      apiKeyEnvVarName: "PAPERCLIP_BOARD_TOKEN",
    });
  });

  it("normalizes invalid file content to safe defaults", () => {
    const contextPath = createTempContextPath();
    writeContext(
      {
        version: 2,
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
