/**
 * Tailscale CLI adapter for the broker.
 *
 * Requirement #4 (command/process injection, ambient authority): commands are
 * built from a fixed token vector plus already-canonicalized integers, executed
 * with `execFile` (never a shell), an absolute binary path, a minimal fixed
 * environment, a working directory of `/`, bounded output, and a hard timeout.
 * The exact argv is exported so tests can assert it and prove no shell is used.
 */

import { execFile } from "node:child_process";

export interface TailscaleCli {
  /** `serve status --json` → raw JSON string. */
  serveStatusJson(): Promise<string>;
  /** Add a same-number HTTPS→loopback proxy for `port`. */
  serveAddHttps(port: number, target: string): Promise<void>;
  /** Remove the HTTPS proxy for `port` (single mapping, never `reset`). */
  serveRemoveHttps(port: number): Promise<void>;
}

export interface TailscaleCliOptions {
  /** Absolute path to a trusted, root-owned tailscale binary. */
  binaryPath: string;
  /** Per-command timeout in milliseconds. */
  timeoutMs?: number;
  /** Max bytes of stdout/stderr to retain. */
  maxBuffer?: number;
}

/**
 * Build the argv vector for a serve operation. Pure and exported so the exact
 * argument list can be unit-asserted. `port` MUST already be a validated
 * canonical integer; this function stringifies it with `String(port)` and never
 * interpolates untrusted text.
 */
export function buildServeArgs(kind: "status" | "add" | "remove", port?: number, target?: string): string[] {
  switch (kind) {
    case "status":
      return ["serve", "status", "--json"];
    case "add":
      if (!Number.isSafeInteger(port) || port === undefined) throw new Error("add requires an integer port");
      if (typeof target !== "string") throw new Error("add requires a target");
      // `tailscale serve --bg --https=<port> <target>` adds one HTTPS listener
      // without touching any other mapping.
      return ["serve", "--bg", `--https=${String(port)}`, target];
    case "remove":
      if (!Number.isSafeInteger(port) || port === undefined) throw new Error("remove requires an integer port");
      // `--https=<port> off` removes exactly that one mapping; never `reset`.
      return ["serve", "--https=" + String(port), "off"];
  }
}

const MINIMAL_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } as const;

function run(opts: TailscaleCliOptions, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      opts.binaryPath,
      args,
      {
        cwd: "/",
        env: { ...MINIMAL_ENV },
        timeout: opts.timeoutMs ?? 10_000,
        maxBuffer: opts.maxBuffer ?? 1024 * 1024,
        windowsHide: true,
        // shell defaults to false — do not change.
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || "").slice(0, 512).replace(/[\r\n]+/g, " ");
          reject(new Error(`tailscale ${args.join(" ")} failed: ${err.message}${detail ? ` | ${detail}` : ""}`));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

export function createTailscaleCli(opts: TailscaleCliOptions): TailscaleCli {
  if (!opts.binaryPath.startsWith("/")) {
    throw new Error("tailscale binaryPath must be absolute");
  }
  return {
    serveStatusJson: () => run(opts, buildServeArgs("status")),
    serveAddHttps: async (port, target) => {
      await run(opts, buildServeArgs("add", port, target));
    },
    serveRemoveHttps: async (port) => {
      await run(opts, buildServeArgs("remove", port));
    },
  };
}
