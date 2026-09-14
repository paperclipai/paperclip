import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import type { RuntimeServiceProviderContext } from "./provider.js";
import { localServiceMacOSNetworkPolicy, localServiceMacOSPlatformPolicy } from "./local-sandbox-macos-platform.js";

const execFileAsync = promisify(execFile);

/** Server-owned, deliberately smaller than an unrestricted local shell. */
export interface RuntimeServiceLocalBoundary {
  kind: "workspace";
  workspaceRoot: string;
  network: "enabled" | "disabled";
}

export function createLocalServiceSandboxLauncher(options: { command?: string; root?: string } = {}) {
  const command = options.command ?? process.env.PAPERCLIP_SERVICE_SANDBOX_COMMAND ?? "codex";
  const root = options.root ?? path.join(resolvePaperclipInstanceRoot(), "runtime-services-v2", "sandbox-homes");
  let support: Promise<void> | undefined;
  async function checkSupport() {
    support ??= execFileAsync(command, ["sandbox", "--help"], { timeout: 10_000, env: { PATH: process.env.PATH }, maxBuffer: 64 * 1024 })
      .then(({ stdout }) => {
        if (!stdout.includes("--permission-profile")) throw new Error("The installed sandbox launcher does not support named permission profiles");
      }).catch((error) => { support = undefined; throw error; });
    return support;
  }
  return async (ctx: RuntimeServiceProviderContext, env: Record<string, string>) => {
    const boundary = ctx.allocationMetadata.localBoundary as RuntimeServiceLocalBoundary | undefined;
    if (!boundary || boundary.kind !== "workspace" || !path.isAbsolute(boundary.workspaceRoot) || !["enabled", "disabled"].includes(boundary.network)) throw new Error("The service has no authorized local execution boundary");
    const workspaceRoot = await fs.realpath(boundary.workspaceRoot);
    const cwd = await fs.realpath(ctx.spec.cwd);
    const relative = path.relative(workspaceRoot, cwd);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("The service directory is outside its authorized workspace");
    if (![ctx.companyId, ctx.serviceId].every((id) => /^[a-f0-9-]{36}$/i.test(id))) throw new Error("Invalid service identity");
    const temp = path.join(cwd, ".paperclip-service-tmp", ctx.serviceId);
    await fs.mkdir(temp, { recursive: true, mode: 0o700 });
    const realTemp = await fs.realpath(temp);
    const tempRelative = path.relative(workspaceRoot, realTemp);
    if (tempRelative === ".." || tempRelative.startsWith(`..${path.sep}`) || path.isAbsolute(tempRelative)) throw new Error("The service temporary directory is outside its authorized workspace");
    if (process.platform === "darwin") {
      // Codex's :minimal process profile adds unconditional shared /tmp writes.
      // Use its pinned, closed base and read-only platform rules directly so
      // an application cannot read another service's scratch files or sockets.
      const policy = `${localServiceMacOSPlatformPolicy}
(allow file-read* (subpath "/usr/local") (subpath "/opt/homebrew") (subpath (param "WORKSPACE_ROOT")))
(allow file-write* (subpath (param "WORKSPACE_ROOT")))
${boundary.network === "enabled" ? `(allow network*)\n${localServiceMacOSNetworkPolicy}` : ""}
`;
      return {
        executable: "/usr/bin/sandbox-exec",
        args: ["-p", policy, `-DWORKSPACE_ROOT=${workspaceRoot}`, "--", "/bin/sh", "-c", ctx.spec.command],
        env: { ...env, HOME: cwd, TMPDIR: realTemp },
      };
    }
    await checkSupport();
    const home = path.join(root, ctx.companyId, ctx.serviceId);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    // No ambient user config, credentials, or skill directories are loaded.
    // The application receives only the explicit service environment.
    const rules = [
      '":root"="none"', '":minimal"="read"', '":tmpdir"="none"',
      // Node/package-manager installations are executable runtime dependencies.
      ...["/usr/local", "/opt/homebrew"].map((location) => `${JSON.stringify(location)}="read"`),
      `${JSON.stringify(workspaceRoot)}="write"`,
    ].join(",");
    return {
      executable: command,
      args: ["sandbox", "-P", "paperclip-service", "-C", cwd,
        "-c", `permissions.paperclip-service.filesystem={${rules}}`,
        "-c", `permissions.paperclip-service.network.enabled=${boundary.network === "enabled"}`,
        "--", "/bin/sh", "-c", ctx.spec.command],
      env: { ...env, CODEX_HOME: home, HOME: cwd, TMPDIR: realTemp },
    };
  };
}
