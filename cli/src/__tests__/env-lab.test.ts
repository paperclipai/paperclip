import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEnvLabCleanupCommand,
  collectEnvLabDoctorStatus,
  resolveEnvLabSshStatePath,
} from "../commands/env-lab.js";

describe("env-lab command", () => {
  it("resolves the default SSH fixture state path under the instance root", () => {
    const statePath = resolveEnvLabSshStatePath("fixture-test");

    expect(statePath).toContain(
      path.join("instances", "fixture-test", "env-lab", "ssh-fixture", "state.json"),
    );
  });

  it("reports doctor status for an instance without a running fixture", async () => {
    const status = await collectEnvLabDoctorStatus({ instance: "fixture-test-missing" });

    expect(status.statePath).toContain(
      path.join("instances", "fixture-test-missing", "env-lab", "ssh-fixture", "state.json"),
    );
    expect(typeof status.ssh.supported).toBe("boolean");
    expect(status.ssh.running).toBe(false);
    expect(status.ssh.environment).toBeNull();
  });
});

describe("env-lab cleanup command hint", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
  });

  // Return the two quoted path arguments from the `node` command.
  function extractPaths(command: string): string[] {
    return [...command.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  }

  it("resolves both CLI paths to absolute paths", () => {
    const command = buildEnvLabCleanupCommand();
    const paths = extractPaths(command);

    expect(paths).toHaveLength(2);
    for (const resolved of paths) {
      expect(path.isAbsolute(resolved)).toBe(true);
    }
    expect(command.endsWith("env-lab down")).toBe(true);
  });

  it("points at the checked-out tsx runner and cli source entry", () => {
    const [tsxBin, entry] = extractPaths(buildEnvLabCleanupCommand());

    expect(tsxBin).toContain(
      path.join("cli", "node_modules", "tsx", "dist", "cli.mjs"),
    );
    expect(entry).toContain(path.join("cli", "src", "index.ts"));
  });

  it("returns the same command from a checkout subdirectory", () => {
    const fromRoot = buildEnvLabCleanupCommand();

    // Simulate a contributor who runs `env-lab doctor` from a subdirectory of
    // the checkout. A relative path would change with the working directory, so
    // this asserts the command stays constant.
    process.chdir(path.dirname(originalCwd));
    const fromParent = buildEnvLabCleanupCommand();
    process.chdir(originalCwd);

    expect(fromParent).toBe(fromRoot);
  });

  it("never restores the unsafe pnpm invocation forms", () => {
    const command = buildEnvLabCleanupCommand();

    // The bare `pnpm paperclipai` script form is unsafe. The `pnpm exec` form
    // does not resolve the CLI binary. Keep both out of the hint.
    expect(command).not.toContain("pnpm paperclipai");
    expect(command).not.toContain("pnpm exec paperclipai");
  });
});
