import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRepoRootEnvFile,
  mergeMissingEnvEntries,
  parseDotenvFile,
  resolveInstanceEnvPath,
} from "../../../scripts/dev-runner-env-file.mjs";

const tempRoots: string[] = [];

function createTempRoot(prefix: string) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe("dev-runner repo-root env file (#13816)", () => {
  // The runner honors these for the real instance directory, so a CI job that
  // runs against a managed instance would otherwise redirect every expectation
  // below. Each test states the overrides it depends on.
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_CONFIG", "");
    vi.stubEnv("PAPERCLIP_HOME", "");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses comments, export prefixes, quoting, escapes, inline comments, and empty values", () => {
    const parsed = parseDotenvFile([
      "# a comment",
      "",
      "PLAIN=value",
      "export EXPORTED=exported-value",
      "  SPACED = spaced-value  ",
      'DOUBLE="line\\nbreak"',
      "SINGLE='raw\\nvalue'",
      'QUOTED_HASHED="kept # inside quotes"',
      "URL=postgres://host/db # local database",
      "EMPTY=",
      "BAD KEY=ignored",
      "=nokey",
    ].join("\n"));

    expect(parsed).toEqual({
      PLAIN: "value",
      EXPORTED: "exported-value",
      SPACED: "spaced-value",
      DOUBLE: "line\nbreak",
      SINGLE: "raw\\nvalue",
      QUOTED_HASHED: "kept # inside quotes",
      URL: "postgres://host/db",
      EMPTY: "",
    });
  });

  it("treats an explicit empty export as set and fills only undefined keys", () => {
    const env = { SET: "from-shell", EMPTY: "" };
    const applied = mergeMissingEnvEntries(env, {
      SET: "from-dotenv",
      EMPTY: "from-dotenv",
      MISSING: "from-dotenv",
    });

    expect(applied).toEqual(["MISSING"]);
    expect(env.SET).toBe("from-shell");
    expect(env.EMPTY).toBe("");
    expect(env.MISSING).toBe("from-dotenv");
  });

  it("applies repo-root keys without displacing shell or instance values", () => {
    const root = createTempRoot("paperclip-dev-runner-env-");
    const instanceDir = path.join(root, "instance");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(path.join(instanceDir, ".env"), "SHARED=instance-value\n");
    writeFileSync(
      path.join(root, ".env"),
      "BETTER_AUTH_SECRET=repo-root-secret\nSHARED=root-value\nPORT=3999\n",
    );
    const env = { PORT: "3100" };
    const lines: string[] = [];

    const result = applyRepoRootEnvFile(env, root, {
      instanceEnvPath: path.join(instanceDir, ".env"),
      log: (line: string) => lines.push(line),
    });

    expect(result.applied).toEqual(["BETTER_AUTH_SECRET"]);
    expect(result.env.BETTER_AUTH_SECRET).toBe("repo-root-secret");
    expect(result.env.SHARED).toBeUndefined();
    expect(result.env.PORT).toBe("3100");
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(lines.join("\n")).toContain("BETTER_AUTH_SECRET");
  });

  it("re-reads the repo-root .env on every call so a restart sees edited values", () => {
    const root = createTempRoot("paperclip-dev-runner-env-edit-");
    writeFileSync(path.join(root, ".env"), "ROTATED=first\n");

    const first = applyRepoRootEnvFile({}, root);
    appendFileSync(path.join(root, ".env"), "ROTATED=second\n");
    const second = applyRepoRootEnvFile({}, root);

    expect(first.env.ROTATED).toBe("first");
    expect(second.env.ROTATED).toBe("second");
  });

  it("is a no-op when the repo root has no .env", () => {
    const root = createTempRoot("paperclip-dev-runner-env-missing-");

    const result = applyRepoRootEnvFile({}, root);

    expect(result.applied).toEqual([]);
    expect(result.env).toEqual({});
  });

  it("resolves the instance env file the same way the server does", () => {
    const root = createTempRoot("paperclip-dev-runner-instance-path-");
    const nested = path.join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    mkdirSync(path.join(root, ".paperclip"), { recursive: true });
    writeFileSync(path.join(root, ".paperclip", "config.json"), "{}");

    expect(resolveInstanceEnvPath({ serverCwd: nested })).toBe(
      path.join(root, ".paperclip", ".env"),
    );
    expect(
      resolveInstanceEnvPath({
        configOverride: path.join(root, "custom.json"),
        serverCwd: nested,
      }),
    ).toBe(path.join(root, ".env"));
    expect(
      resolveInstanceEnvPath({
        serverCwd: "/nonexistent-paperclip-root-for-test",
        homeOverride: "",
        instanceIdOverride: "",
        homedir: () => "/home/tester",
      }),
    ).toBe(path.join("/home/tester", ".paperclip", "instances", "default", ".env"));
  });

  it("honors PAPERCLIP_HOME and PAPERCLIP_INSTANCE_ID in the fallback instance", () => {
    // Matches packages/shared/home-paths.ts: the fallback instance root is
    // `<PAPERCLIP_HOME or ~/.paperclip>/instances/<PAPERCLIP_INSTANCE_ID or
    // default>`, so a non-default instance's keys are protected too.
    const base = {
      serverCwd: "/nonexistent-paperclip-root-for-test",
      homedir: () => "/home/tester",
    };
    expect(
      resolveInstanceEnvPath({ ...base, homeOverride: "/srv/p8", instanceIdOverride: "staging" }),
    ).toBe(path.join("/srv/p8", "instances", "staging", ".env"));
    expect(
      resolveInstanceEnvPath({ ...base, homeOverride: "~/alt", instanceIdOverride: "" }),
    ).toBe(path.join("/home/tester", "alt", "instances", "default", ".env"));
    expect(
      resolveInstanceEnvPath({ ...base, homeOverride: "", instanceIdOverride: " beta_1 " }),
    ).toBe(path.join("/home/tester", ".paperclip", "instances", "beta_1", ".env"));
  });

  it("stops the start when the repo-root .env exists but cannot be read", () => {
    // A read failure (not a missing file) must not degrade silently into an
    // empty env: the server would start without the secrets the file holds.
    const root = createTempRoot("paperclip-dev-runner-env-unreadable-");
    mkdirSync(path.join(root, ".env"));

    expect(() => applyRepoRootEnvFile({}, root)).toThrow(
      /could not read the repo-root env file/,
    );
  });

  it("warns instead of failing when the instance .env cannot be read", () => {
    const root = createTempRoot("paperclip-dev-runner-instance-unreadable-");
    const instanceDir = path.join(root, "instance");
    mkdirSync(path.join(instanceDir, ".env"), { recursive: true });
    writeFileSync(path.join(root, ".env"), "SHARED=root-value\n");
    const lines: string[] = [];

    const result = applyRepoRootEnvFile({}, root, {
      instanceEnvPath: path.join(instanceDir, ".env"),
      log: (line: string) => lines.push(line),
    });

    // The instance keys are unknown, so the repo-root value is applied and
    // the operator sees the read failure in the runner output.
    expect(result.applied).toEqual(["SHARED"]);
    expect(lines.join("\n")).toContain("could not read the instance env file");
  });

  it("re-resolves the instance path on every call, not once at runner start", () => {
    // A restart after `.paperclip/config.json` moves to a closer ancestor
    // must consult the new instance file, not the one cached at startup.
    const root = createTempRoot("paperclip-dev-runner-instance-switch-");
    const serverDir = path.join(root, "server");
    mkdirSync(serverDir, { recursive: true });
    mkdirSync(path.join(root, ".paperclip"), { recursive: true });
    writeFileSync(path.join(root, ".paperclip", "config.json"), "{}");
    writeFileSync(path.join(root, ".paperclip", ".env"), "SHARED=far-instance\n");
    writeFileSync(path.join(root, ".env"), "SHARED=root-value\n");

    const first = applyRepoRootEnvFile({}, root);
    expect(first.applied).toEqual([]);

    // The nearer instance takes over and does not protect SHARED.
    mkdirSync(path.join(serverDir, ".paperclip"), { recursive: true });
    writeFileSync(path.join(serverDir, ".paperclip", "config.json"), "{}");
    const second = applyRepoRootEnvFile({}, root);
    expect(second.applied).toEqual(["SHARED"]);
    expect(second.env.SHARED).toBe("root-value");
  });
});
