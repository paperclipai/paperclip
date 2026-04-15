import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeHermesConfigForPersistence,
  resolveHermesRuntimeConfig,
} from "../services/hermes-config.js";

const tempRoots: string[] = [];

function makeTempDir(name: string) {
  const dir = path.join(tmpdir(), `paperclip-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("normalizeHermesConfigForPersistence", () => {
  it("moves legacy HERMES_HOME into command fields when no command exists yet", () => {
    const result = normalizeHermesConfigForPersistence({
      env: {
        HERMES_HOME: {
          type: "plain",
          value: "/Users/seb/.hermes/profiles/hermes-lebi-cmo",
        },
      },
      timeoutSec: 0,
    });

    expect(result).toMatchObject({
      command: "/Users/seb/.hermes/profiles/hermes-lebi-cmo",
      hermesCommand: "/Users/seb/.hermes/profiles/hermes-lebi-cmo",
      timeoutSec: 0,
    });
    expect(result.env).toEqual({});
  });

  it("keeps wrapper-script commands and only drops the legacy HERMES_HOME env key", () => {
    const result = normalizeHermesConfigForPersistence({
      command: "/Users/seb/.local/bin/hermes-comandero-ceo",
      hermesCommand: "/Users/seb/.local/bin/hermes-comandero-ceo",
      env: {
        HERMES_HOME: {
          type: "plain",
          value: "/Users/seb/.hermes/profiles/hermes-comandero-ceo",
        },
        LOG_LEVEL: {
          type: "plain",
          value: "debug",
        },
      },
    });

    expect(result.command).toBe("/Users/seb/.local/bin/hermes-comandero-ceo");
    expect(result.hermesCommand).toBe("/Users/seb/.local/bin/hermes-comandero-ceo");
    expect(result.env).toEqual({
      LOG_LEVEL: {
        type: "plain",
        value: "debug",
      },
    });
  });
});

describe("resolveHermesRuntimeConfig", () => {
  it("treats directory-valued Hermes commands as HERMES_HOME and falls back to the default CLI", async () => {
    const profileDir = makeTempDir("hermes-profile");

    const result = resolveHermesRuntimeConfig("hermes_local", {
      command: profileDir,
      hermesCommand: profileDir,
      timeoutSec: 0,
    });

    expect(result.timeoutSec).toBe(-1);
    expect(result.command).toBe("hermes");
    expect(result.hermesCommand).toBe("hermes");
    expect(result.env).toMatchObject({
      HERMES_HOME: profileDir,
    });
  });

  it("keeps executable Hermes commands unchanged", async () => {
    const binDir = makeTempDir("hermes-bin");
    const executablePath = path.join(binDir, "hermes-custom");
    writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", "utf8");

    const result = resolveHermesRuntimeConfig("hermes_local", {
      command: executablePath,
      hermesCommand: executablePath,
      timeoutSec: 0,
    });

    expect(result.timeoutSec).toBe(-1);
    expect(result.command).toBe(executablePath);
    expect(result.hermesCommand).toBe(executablePath);
    expect(result.env ?? {}).not.toHaveProperty("HERMES_HOME");
  });
});
