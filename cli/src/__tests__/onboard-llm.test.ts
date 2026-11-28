import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onboard } from "../commands/onboard.js";
import { readConfig } from "../config/store.js";
import { promptLlm } from "../prompts/llm.js";

const { spinnerStop } = vi.hoisted(() => ({ spinnerStop: vi.fn() }));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  log: { message: vi.fn(), step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn() },
  select: vi.fn(async () => "advanced"),
  isCancel: vi.fn(() => false),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: spinnerStop })),
}));
vi.mock("../prompts/database.js", () => ({ promptDatabase: vi.fn(async (current) => current) }));
vi.mock("../prompts/llm.js", () => ({ promptLlm: vi.fn() }));
vi.mock("../prompts/logging.js", () => ({
  promptLogging: vi.fn(async () => ({ mode: "file", logDir: path.join(process.env.PAPERCLIP_HOME!, "logs") })),
}));
vi.mock("../prompts/server.js", () => ({
  promptServer: vi.fn(async ({ currentServer, currentAuth }) => ({ server: currentServer, auth: currentAuth })),
}));
vi.mock("../prompts/storage.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../prompts/storage.js")>(),
  promptStorage: vi.fn(async (current) => current),
}));
vi.mock("../commands/auth-bootstrap-ceo.js", () => ({ bootstrapCeoInvite: vi.fn() }));
vi.mock("../onboard-service.js", () => ({
  handleOnboardService: vi.fn(async () => false),
  handoffToOnboardedService: vi.fn(),
  shouldOfferForegroundStart: vi.fn(() => false),
}));
vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => null),
  trackInstallStarted: vi.fn(),
  trackInstallCompleted: vi.fn(),
}));

let home: string;
let configPath: string;

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PAPERCLIP_") || key.startsWith("BETTER_AUTH_") || ["DATABASE_URL", "HOST", "PORT", "SERVE_UI"].includes(key)) {
      vi.stubEnv(key, undefined);
    }
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-onboard-llm-"));
  configPath = path.join(home, "config.json");
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(promptLlm).mockResolvedValue({ provider: "claude", apiKey: "test-key" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("onboard Claude key validation", () => {
  it("sends the recommended model with a one-token request without up-front thinking", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 200 }));

    await onboard({ config: configPath, bind: "loopback", installService: false });

    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        max_tokens: 1,
        thinking: { type: "between_tools" },
        output_config: { effort: "low" },
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(spinnerStop).toHaveBeenCalledWith("API key is valid");
    expect(readConfig(configPath)?.llm).toEqual({ provider: "claude", apiKey: "test-key" });
  });

  it.each([
    [400, "API key is valid"],
    [401, "API key appears invalid"],
    [403, "Could not validate API key"],
    [404, "Could not validate API key"],
    [429, "Could not validate API key"],
    [500, "Could not validate API key"],
  ])("continues setup after status %i with the expected validation result", async (status, message) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status }));

    await onboard({ config: configPath, bind: "loopback", installService: false });

    expect(spinnerStop).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(readConfig(configPath)?.llm?.apiKey).toBe("test-key");
  });

  it("continues setup when the key check cannot reach the API", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Connection unavailable"));

    await onboard({ config: configPath, bind: "loopback", installService: false });

    expect(spinnerStop).toHaveBeenCalledWith(expect.stringContaining("Could not reach API"));
    expect(readConfig(configPath)?.llm?.apiKey).toBe("test-key");
  });

  it("does not call the API when no LLM provider is configured", async () => {
    vi.mocked(promptLlm).mockResolvedValueOnce(undefined);

    await onboard({ config: configPath, bind: "loopback", installService: false });

    expect(fetch).not.toHaveBeenCalled();
    expect(readConfig(configPath)?.llm).toBeUndefined();
    expect(p.outro).toHaveBeenCalledWith("You're all set!");
  });
});
