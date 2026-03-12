import { beforeEach, describe, expect, it, vi } from "vitest";

const noteMock = vi.fn();
const introMock = vi.fn();
const outroMock = vi.fn();
const messageMock = vi.fn();
const successMock = vi.fn();
const errorMock = vi.fn();
const confirmMock = vi.fn();
const printBannerMock = vi.fn();
const loadPaperclipEnvFileMock = vi.fn();
const readRepoStartupProfileMock = vi.fn();
const readRecentLaunchHistoryMock = vi.fn();
const resolveConfigPathMock = vi.fn();
const readConfigMock = vi.fn();

function pass(name: string, message = "ok") {
  return { name, status: "pass" as const, message };
}

vi.mock("@clack/prompts", () => ({
  intro: introMock,
  outro: outroMock,
  note: noteMock,
  confirm: confirmMock,
  isCancel: () => false,
  log: {
    message: messageMock,
    success: successMock,
    error: errorMock,
  },
}));

vi.mock("../utils/banner.js", () => ({
  printPaperclipCliBanner: printBannerMock,
}));

vi.mock("../config/env.js", () => ({
  loadPaperclipEnvFile: loadPaperclipEnvFileMock,
}));

vi.mock("../config/store.js", () => ({
  resolveConfigPath: resolveConfigPathMock,
  readConfig: readConfigMock,
}));

vi.mock("../config/startup-profile.js", () => ({
  readRepoStartupProfile: readRepoStartupProfileMock,
  readRecentLaunchHistory: readRecentLaunchHistoryMock,
}));

vi.mock("../checks/index.js", () => ({
  configCheck: vi.fn(() => pass("Config file")),
  deploymentAuthCheck: vi.fn(() => pass("Deployment")),
  agentJwtSecretCheck: vi.fn(() => pass("Agent JWT")),
  secretsCheck: vi.fn(() => pass("Secrets")),
  storageCheck: vi.fn(() => pass("Storage")),
  databaseCheck: vi.fn(() => pass("Database")),
  llmCheck: vi.fn(async () => pass("LLM")),
  logCheck: vi.fn(() => pass("Logs")),
  portCheck: vi.fn(async () => pass("Port")),
}));

describe("doctor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveConfigPathMock.mockReturnValue("/tmp/paperclip/config.json");
    readConfigMock.mockReturnValue({ server: {}, database: {}, llm: {}, logging: {}, secrets: {}, storage: {} });
    readRepoStartupProfileMock.mockReturnValue({
      profilePath: "/repo/.paperclip/local-start.json",
      paperclipHome: "/runtime-home",
      instanceId: "default",
      configPath: "/runtime-home/instances/default/config.json",
      lastUsedAt: "2026-03-10T10:00:00.000Z",
    });
    readRecentLaunchHistoryMock.mockReturnValue([
      {
        recordedAt: "2026-03-10T10:05:00.000Z",
        result: "ready",
        startupSource: "repo_profile",
        databaseRef: "/runtime-home/instances/default/db",
      },
    ]);
  });

  it("shows the repo startup profile and recent launch history when requested", async () => {
    const { doctor } = await import("../commands/doctor.js");

    await doctor({ launchHistory: true });

    expect(printBannerMock).toHaveBeenCalled();
    expect(loadPaperclipEnvFileMock).toHaveBeenCalledWith("/tmp/paperclip/config.json");
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("profile: /repo/.paperclip/local-start.json"),
      "Repo Startup Profile",
    );
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("2026-03-10T10:05:00.000Z  ready  (repo_profile)"),
      "Launch History",
    );
  });
});
