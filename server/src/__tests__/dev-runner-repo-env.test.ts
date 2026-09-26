import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
        homedir: () => "/home/tester",
      }),
    ).toBe(path.join("/home/tester", ".paperclip", "instances", "default", ".env"));
  });
});
