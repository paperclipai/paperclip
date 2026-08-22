import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main, parseArgs } from "./refresh-dev-models.js";

function sampleConfig(models: Record<string, { name: string }>) {
  return {
    provider: {
      dev: {
        options: { baseURL: "http://localhost:11434/v1" },
        models,
      },
    },
  };
}

describe("refresh-dev-models CLI parseArgs", () => {
  it("parses all supported flags", () => {
    const { options, quiet } = parseArgs([
      "--config",
      "/tmp/x.json",
      "--ollama-url",
      "http://h:1",
      "--provider-key",
      "dev",
      "--timeout-ms",
      "1234",
      "--dry-run",
      "--quiet",
    ]);
    expect(options.configPath).toBe("/tmp/x.json");
    expect(options.ollamaUrl).toBe("http://h:1");
    expect(options.providerKey).toBe("dev");
    expect(options.timeoutMs).toBe(1234);
    expect(options.dryRun).toBe(true);
    expect(quiet).toBe(true);
  });

  it("returns help and exits 0 for --help", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(main(["--help"])).resolves.toBe(0);
    spy.mockRestore();
  });

  it("returns exit code 1 on unknown argument", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(main(["--nope"])).resolves.toBe(1);
    spy.mockRestore();
  });
});

describe("refresh-dev-models CLI main (temp fs)", () => {
  let dir: string;
  let configPath: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "refresh-cli-test-"));
    configPath = path.join(dir, "opencode.json");
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns 1 (fail-safe) when the config cannot be read, without writing", async () => {
    // No file written at configPath -> read fails -> fail-safe exit 1.
    await expect(main(["--config", configPath, "--quiet"])).resolves.toBe(1);
    await expect(fs.readFile(configPath, "utf8")).rejects.toBeTruthy();
  });

  it("returns 1 (fail-safe) on a malformed config and leaves the file intact", async () => {
    const garbage = "{ not : valid ]";
    await fs.writeFile(configPath, garbage);
    await expect(main(["--config", configPath, "--quiet"])).resolves.toBe(1);
    expect(await fs.readFile(configPath, "utf8")).toBe(garbage);
  });
});
