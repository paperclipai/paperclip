import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prompts from "@clack/prompts";
import { configure } from "../commands/configure.js";
import { readConfig } from "../config/store.js";

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    error: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../prompts/server.js", () => ({
  promptServer: vi.fn(async ({ currentServer, currentAuth }) => ({
    server: currentServer,
    auth: currentAuth,
  })),
}));

const ORIGINAL_EXIT_CODE = process.exitCode;
let originalStdinIsTTY: boolean | undefined;
let originalStdoutIsTTY: boolean | undefined;

beforeEach(() => {
  originalStdinIsTTY = process.stdin.isTTY;
  originalStdoutIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  vi.mocked(prompts.confirm).mockResolvedValue(true);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: originalStdinIsTTY,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: originalStdoutIsTTY,
  });
  process.exitCode = ORIGINAL_EXIT_CODE;
  vi.restoreAllMocks();
});

describe("configure invalid-config repair", () => {
  it("repairs only after confirmation and commits the staged config atomically", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-repair-"));
    const configPath = path.join(root, "config.json");
    const invalidBytes = Buffer.from('{"server": invalid}\n', "utf8");
    fs.writeFileSync(configPath, invalidBytes);
    const rename = vi.spyOn(fs, "renameSync");

    try {
      await configure({ config: configPath, section: "server" });

      expect(prompts.confirm).toHaveBeenCalledWith({
        message: `Repair from defaults? The invalid original is backed up at ${configPath}.invalid-1.`,
        initialValue: false,
      });
      expect(fs.readFileSync(`${configPath}.invalid-1`)).toEqual(invalidBytes);
      expect(readConfig(configPath)).not.toBeNull();
      expect(rename).toHaveBeenCalledWith(
        expect.stringMatching(/config\.json\.tmp-\d+-\d+$/),
        configPath,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
