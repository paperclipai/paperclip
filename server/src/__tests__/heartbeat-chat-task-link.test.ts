import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPaperclipTaskMarkdown } from "../services/heartbeat.js";
import { runtimeCanonicalOrigin } from "../services/cloud-runtime-identity.js";
import { readConfigFile } from "../config-file.js";

vi.mock("../services/cloud-runtime-identity.js", () => ({
  runtimeCanonicalOrigin: vi.fn(() => null),
}));
vi.mock("../config-file.js", () => ({ readConfigFile: vi.fn(() => null) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(runtimeCanonicalOrigin).mockReturnValue(null);
  vi.mocked(readConfigFile).mockReturnValue(null);
});

const issue = { id: "task-123", identifier: "TEST-1", title: "Chat request" };

describe("external chat task link context", () => {
  it.each(["slack", "discord", "telegram", "agentmail"])(
    "supplies the public task link for fresh and resumed %s turns",
    (externalChatProvider) => {
      vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "https://pool.example");
      vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
      vi.mocked(runtimeCanonicalOrigin).mockReturnValue("https://vanity.example");
      for (const includeDescription of [true, false]) {
        for (const nativeRunner of [true, false]) {
          const markdown = buildPaperclipTaskMarkdown({ issue, externalChatProvider, nativeRunner, includeDescription });
          expect(markdown).toContain("Public task URL: https://vanity.example/issues/task-123");
          expect(markdown).toContain("use this exact URL");
          expect(markdown).toContain("Opening it still requires Paperclip access");
          expect(markdown).not.toContain("https://pool.example");
          expect(markdown).not.toContain("http://localhost:3100");
        }
      }
    },
  );

  it.each(["", "http://localhost:3100", "https://board.internal", "https://user:secret@board.example"])(
    "does not invent a task link from missing or unsafe configuration (%s)",
    (publicUrl) => {
      for (const name of ["PAPERCLIP_AUTH_PUBLIC_BASE_URL", "BETTER_AUTH_URL", "BETTER_AUTH_BASE_URL", "PAPERCLIP_PUBLIC_URL", "PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL"]) vi.stubEnv(name, "");
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", publicUrl);
      vi.stubEnv("PAPERCLIP_API_URL", "https://api.example");
      vi.stubEnv("PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL", "https://ingress.example");
      const markdown = buildPaperclipTaskMarkdown({ issue, externalChatProvider: "slack" });
      expect(markdown).toContain("No public task URL is configured");
      expect(markdown).toContain("do not invent a URL");
      expect(markdown).not.toContain("Public task URL:");
      expect(markdown).not.toContain("https://api.example");
      expect(markdown).not.toContain("https://ingress.example");
    },
  );
});
