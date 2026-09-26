import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyRepoRootEnvFile,
  mergeMissingEnvEntries,
  parseDotenvFile,
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
  it("parses comments, export prefixes, quoting, and escapes", () => {
    const parsed = parseDotenvFile([
      "# a comment",
      "",
      "PLAIN=value",
      "export EXPORTED=exported-value",
      "  SPACED = spaced-value  ",
      'DOUBLE="line\\nbreak"',
      "SINGLE='raw\\nvalue'",
      'HASHED="not # a comment"',
      "BAD KEY=ignored",
      "=nokey",
    ].join("\n"));

    expect(parsed).toEqual({
      PLAIN: "value",
      EXPORTED: "exported-value",
      SPACED: "spaced-value",
      DOUBLE: "line\nbreak",
      SINGLE: "raw\\nvalue",
      HASHED: "not # a comment",
    });
  });

  it("keeps real env values and fills only missing keys", () => {
    const env: Record<string, string | undefined> = {
      SET: "from-shell",
      EMPTY: "",
    };
    const applied = mergeMissingEnvEntries(env, {
      SET: "from-dotenv",
      EMPTY: "from-dotenv",
      MISSING: "from-dotenv",
    });

    expect(applied).toEqual(["EMPTY", "MISSING"]);
    expect(env.SET).toBe("from-shell");
    expect(env.EMPTY).toBe("from-dotenv");
    expect(env.MISSING).toBe("from-dotenv");
  });

  it("loads the repo-root .env into the spawned server env", () => {
    const root = createTempRoot("paperclip-dev-runner-env-");
    writeFileSync(path.join(root, ".env"), "BETTER_AUTH_SECRET=repo-root-secret\nPORT=3999\n");
    const env: Record<string, string | undefined> = { PORT: "3100" };
    const lines: string[] = [];

    const applied = applyRepoRootEnvFile(env, root, { log: (line: string) => lines.push(line) });

    expect(applied).toEqual(["BETTER_AUTH_SECRET"]);
    expect(env.BETTER_AUTH_SECRET).toBe("repo-root-secret");
    expect(env.PORT).toBe("3100");
    expect(lines.join("\n")).toContain("BETTER_AUTH_SECRET");
  });

  it("is a no-op when the repo root has no .env", () => {
    const root = createTempRoot("paperclip-dev-runner-env-missing-");
    const env: Record<string, string | undefined> = {};

    expect(applyRepoRootEnvFile(env, root)).toEqual([]);
    expect(env).toEqual({});
  });
});
