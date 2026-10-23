import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertIsolatedHostAssetDirectory } from "@paperclipai/adapter-utils/isolated-host-file";
import { createManagedAiCredentialHome } from "../services/ai-connection-runtime.js";

describe("managed AI credential home", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.skipIf(process.platform !== "linux")("keeps the isolated Claude asset under an agent-immutable root", async () => {
    const instanceHome = await fs.mkdtemp(path.join(process.cwd(), ".managed-ai-home-test-"));
    try {
      vi.stubEnv("PAPERCLIP_HOME", instanceHome);
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "managed-ai-home-test");
      vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
      vi.stubEnv("PAPERCLIP_SECRETS_HOST_AGENT_UID", String((process.getuid?.() ?? 0) + 100000));

      const home = await createManagedAiCredentialHome("company-1", "grant-1");
      expect(home.startsWith(path.join(instanceHome, "instances", "managed-ai-home-test", "runtime", "managed-ai-homes"))).toBe(true);
      expect((await fs.stat(home)).mode & 0o077).toBe(0);
      const provider = path.join(home, "provider");
      await fs.mkdir(provider, { mode: 0o700 });
      await fs.writeFile(path.join(provider, "CLAUDE.md"), "ordinary seed", { mode: 0o600 });
      await expect(assertIsolatedHostAssetDirectory(provider)).resolves.toBeUndefined();
    } finally {
      await fs.rm(instanceHome, { recursive: true, force: true });
    }
  });

  it("preserves the disposable temp home outside isolation mode", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "false");
    const home = await createManagedAiCredentialHome("company-1", "grant-1");
    try {
      expect(path.dirname(home)).toBe(os.tmpdir());
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects path separators in the home identity", async () => {
    await expect(createManagedAiCredentialHome("../other", "grant-1")).rejects.toThrow("Invalid managed AI credential home identity");
  });
});
