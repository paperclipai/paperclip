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
  it("starts direct Google services in Camoufox", async () => {
    const bin = await fakeBrowserPath();
    const result = await execFileAsync("/bin/sh", [launcher, "https://mail.google.com/mail/u/0"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(result.stdout).toContain("camoufox:https://mail.google.com/mail/u/0");
    expect(result.stderr).toContain("Google domain detected");
  });

  it("restarts an OAuth flow in Camoufox when it redirects to Google", async () => {
    const bin = await fakeBrowserPath();
    const result = await execFileAsync("/bin/sh", [launcher, "https://authn.read.ai/authorize"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        FAKE_CURRENT_URL: "https://accounts.google.com/v3/signin",
      },
    });
    expect(result.stdout).toContain("camoufox:https://authn.read.ai/authorize");
    expect(result.stderr).toContain("navigation reached Google");
  });

  it("keeps an ordinary unblocked site in agent-browser", async () => {
    const bin = await fakeBrowserPath();
    const result = await execFileAsync("/bin/sh", [launcher, "https://example.com"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(result.stdout).toContain('{"provider":"agent-browser","status":"ready"}');
  });
});
