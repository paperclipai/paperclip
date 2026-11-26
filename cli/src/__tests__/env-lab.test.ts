import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as p from "@clack/prompts";
import {
  buildEnvLabCleanupCommand,
  collectEnvLabDoctorStatus,
  envLabDoctorCommand,
  resolveEnvLabCliInvocation,
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

  // Resolve a source-checkout invocation for a fabricated checkout root. A source
  // checkout runs this module from `<root>/src/commands/env-lab.ts`, so the
  // resolver reads that layout and returns the tsx runner and source entry.
  function sourceInvocation(root: string) {
    return resolveEnvLabCliInvocation(path.join(root, "src", "commands", "env-lab.ts"));
  }

  // Resolve a bundled-build invocation for a fabricated package root. The bundled
  // build runs this module from `<root>/dist/index.js`, so the resolver returns
  // that file as the entry with no tsx runner.
  function bundledInvocation(root: string) {
    return resolveEnvLabCliInvocation(path.join(root, "dist", "index.js"));
  }

  // Split a command that uses POSIX single-quoting into its argument tokens. The
  // parser reads a single-quoted span verbatim and reads `\'` outside a span as a
  // literal single quote. This is the same rule a POSIX shell obeys, so a token
  // list proves the shell reads the exact paths and runs no embedded command.
  function tokenizePosix(command: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let started = false;
    let inQuotes = false;
    for (let index = 0; index < command.length; index += 1) {
      const character = command[index];
      if (inQuotes) {
        if (character === "'") {
          inQuotes = false;
        } else {
          current += character;
        }
      } else if (character === "'") {
        inQuotes = true;
        started = true;
      } else if (character === "\\") {
        index += 1;
        current += command[index];
        started = true;
      } else if (character === " ") {
        if (started) {
          tokens.push(current);
          current = "";
          started = false;
        }
      } else {
        current += character;
        started = true;
      }
    }
    if (started) {
      tokens.push(current);
    }
    return tokens;
  }

  // Return the two path arguments from the `node` command.
  function extractPaths(command: string): string[] {
    const tokens = tokenizePosix(command);
    return tokens.slice(1, 3);
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

  // A checkout path can hold shell metacharacters. A contributor copies the hint
  // and pastes it into a shell. The hint must neutralize each metacharacter, so
  // the shell reads the exact path and runs no embedded command. Each case below
  // is a checkout root with one dangerous construct.
  const dangerousRoots = [
    { label: "a dollar sign", root: "/tmp/env$lab/checkout" },
    { label: "command substitution", root: "/tmp/$(touch pwned)/checkout" },
    { label: "backticks", root: "/tmp/`touch pwned`/checkout" },
    { label: "a double quote", root: '/tmp/env"lab/checkout' },
    { label: "a single quote", root: "/tmp/env'lab/checkout" },
  ];

  for (const { label, root } of dangerousRoots) {
    it(`keeps a checkout path with ${label} inert in the cleanup hint`, () => {
      const command = buildEnvLabCleanupCommand({ invocation: sourceInvocation(root) });
      const tokens = tokenizePosix(command);
      const tsxBin = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
      const entry = path.join(root, "src", "index.ts");

      // The shell reads the exact paths as single argument tokens. It does not
      // split the paths or run the embedded construct.
      expect(tokens).toEqual(["node", tsxBin, entry, "env-lab", "down"]);

      // The old double-quoted form left `$(...)`, a backtick pair, and `$NAME`
      // live. Do not restore it.
      expect(command).not.toContain(`"${tsxBin}"`);
      expect(command).not.toContain(`"${entry}"`);
    });
  }

  it("forwards the inspected instance to the cleanup hint", () => {
    const command = buildEnvLabCleanupCommand({
      instance: "fixture-test",
      invocation: sourceInvocation("/tmp/checkout"),
    });
    const tokens = tokenizePosix(command);

    // The hint ends with `--instance <id>`, so it stops the fixture the doctor
    // command diagnosed, not the default instance.
    expect(tokens.slice(-2)).toEqual(["--instance", "fixture-test"]);
  });

  it("omits the instance flag when the doctor command uses the default instance", () => {
    const command = buildEnvLabCleanupCommand({ invocation: sourceInvocation("/tmp/checkout") });

    // Without a selected instance, `env-lab down` resolves the same default
    // instance the doctor command inspected. Do not add an empty flag.
    expect(command).not.toContain("--instance");
    expect(command.endsWith("env-lab down")).toBe(true);
  });

  it("keeps an instance id with shell metacharacters inert", () => {
    const command = buildEnvLabCleanupCommand({
      instance: "$(touch pwned)",
      invocation: sourceInvocation("/tmp/checkout"),
    });
    const tokens = tokenizePosix(command);

    // The shell reads the instance id as one literal token and runs no embedded
    // command.
    expect(tokens.slice(-2)).toEqual(["--instance", "$(touch pwned)"]);
    expect(command).not.toContain('"$(touch pwned)"');
  });

  it("runs the bundled dist entry directly, without the tsx runner", () => {
    const command = buildEnvLabCleanupCommand({
      invocation: bundledInvocation("/opt/pkg"),
    });
    const tokens = tokenizePosix(command);

    // The published package ships one `dist/index.js` file and no tsx runner, so
    // node runs that file directly.
    expect(tokens).toEqual(["node", path.join("/opt/pkg", "dist", "index.js"), "env-lab", "down"]);
    expect(command).not.toContain("tsx");
    expect(command).not.toContain(path.join("src", "index.ts"));
  });

  it("keeps a bundled package path with shell metacharacters inert", () => {
    const root = "/opt/$(touch pwned)/pkg";
    const command = buildEnvLabCleanupCommand({ invocation: bundledInvocation(root) });
    const tokens = tokenizePosix(command);
    const entry = path.join(root, "dist", "index.js");

    // The shell reads the exact bundled path as one token and runs no embedded
    // command.
    expect(tokens).toEqual(["node", entry, "env-lab", "down"]);
    expect(command).not.toContain(`"${entry}"`);
  });
});

describe("env-lab doctor cleanup hint instance", () => {
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  afterEach(() => {
    if (originalInstanceId === undefined) {
      delete process.env.PAPERCLIP_INSTANCE_ID;
    } else {
      process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
    }
    vi.restoreAllMocks();
  });

  // Capture the cleanup hint the doctor prints. The doctor reports through
  // `p.log`, so the test replaces each channel and reads the captured lines.
  function captureDoctorMessages(): string[] {
    const messages: string[] = [];
    vi.spyOn(p.log, "message").mockImplementation((message?: string | string[]) => {
      messages.push(Array.isArray(message) ? message.join("\n") : (message ?? ""));
    });
    vi.spyOn(p.log, "success").mockImplementation(() => {});
    vi.spyOn(p.log, "warn").mockImplementation(() => {});
    vi.spyOn(p.log, "info").mockImplementation(() => {});
    return messages;
  }

  it("pins the PAPERCLIP_INSTANCE_ID instance when opts.instance is absent", async () => {
    // The doctor diagnoses the instance that `PAPERCLIP_INSTANCE_ID` selects.
    // The cleanup hint must target that instance, not the default instance.
    process.env.PAPERCLIP_INSTANCE_ID = "env-selected-instance";
    const messages = captureDoctorMessages();

    await envLabDoctorCommand({ instance: undefined });

    const cleanup = messages.find((message) => message.startsWith("Cleanup:"));
    expect(cleanup).toBeDefined();
    expect(cleanup).toContain("env-lab down");
    expect(cleanup).toContain("--instance");
    expect(cleanup).toContain("env-selected-instance");
  });

  it("pins the explicit instance over PAPERCLIP_INSTANCE_ID", async () => {
    // An explicit `--instance` flag overrides the environment variable, so the
    // hint targets the explicit instance the doctor inspected.
    process.env.PAPERCLIP_INSTANCE_ID = "env-selected-instance";
    const messages = captureDoctorMessages();

    await envLabDoctorCommand({ instance: "explicit-instance" });

    const cleanup = messages.find((message) => message.startsWith("Cleanup:"));
    expect(cleanup).toBeDefined();
    expect(cleanup).toContain("--instance");
    expect(cleanup).toContain("explicit-instance");
    expect(cleanup).not.toContain("env-selected-instance");
  });
});
