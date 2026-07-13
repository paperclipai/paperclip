import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/browser/paperclip-browser-open");
const managedAgentBrowser = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/browser/agent-browser-managed",
);

async function fakeBrowserPath() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-provider-routing-"));
  tempRoots.push(root);
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "paperclip-camoufox"),
    "#!/bin/sh\nprintf 'camoufox:%s\\n' \"$1\"\n",
  );
  await fs.writeFile(
    path.join(bin, "agent-browser"),
    `#!/bin/sh
case "$1:$2" in
  get:title) printf '%s\\n' "Example" ;;
  get:url) printf '%s\\n' "\${FAKE_CURRENT_URL:-https://example.com}" ;;
  snapshot:*) printf '%s\\n' "Example page" ;;
esac
`,
  );
  await Promise.all([
    fs.chmod(path.join(bin, "paperclip-camoufox"), 0o755),
    fs.chmod(path.join(bin, "agent-browser"), 0o755),
  ]);
  return bin;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed browser provider routing", () => {
  it("starts every managed URL in Camoufox", async () => {
    const bin = await fakeBrowserPath();
    const result = await execFileAsync("/bin/sh", [launcher, "https://example.com"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(result.stdout).toContain("camoufox:https://example.com");
    expect(result.stderr).toContain("provider=camoufox (agent-browser disabled)");
  });

  it("does not allow an environment override to restore agent-browser", async () => {
    const bin = await fakeBrowserPath();
    const result = await execFileAsync("/bin/sh", [launcher, "https://example.com"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PAPERCLIP_BROWSER_PROVIDER: "agent-browser",
      },
    });
    expect(result.stdout).toContain("camoufox:https://example.com");
    expect(result.stderr).toContain("ignoring PAPERCLIP_BROWSER_PROVIDER=agent-browser");
  });

  it("blocks direct agent-browser commands", async () => {
    const bin = await fakeBrowserPath();
    await expect(execFileAsync("/bin/sh", [managedAgentBrowser, "open", "https://example.com"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PAPERCLIP_AGENT_BROWSER_REAL: path.join(bin, "agent-browser"),
        AGENT_BROWSER_SESSION_NAME: "company-default",
        PAPERCLIP_COMPANY_ID: "company-1",
      },
    })).rejects.toMatchObject({
      code: 69,
      stderr: expect.stringContaining("agent-browser is disabled"),
    });
  });
});
