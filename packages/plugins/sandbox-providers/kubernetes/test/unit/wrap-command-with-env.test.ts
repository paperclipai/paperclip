import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { Exec } from "@kubernetes/client-node";
import type { KubeConfig } from "@kubernetes/client-node";
import { boundCommandToStdin, wrapCommandWithEnv } from "../../src/pod-exec.js";

// Fake (obviously non-real) secret values. The tests assert none of them ever
// appears in the exec argv or in the exec request URI built from it.
// If quoting ever regressed and the shell ran the substitution in SHELLY, this
// file would be created; the real-shell test asserts it never is.
const MARKER_DIR = mkdtempSync(join(tmpdir(), "wrap-env-"));
const INJECTION_MARKER = join(MARKER_DIR, "should-not-exist");
const SECRET_ENV = {
  RAMP_ROUTER_API_KEY: "rr-fake-model-key-0001",
  ANTHROPIC_API_KEY: "sk-ant-fake-0002",
  PAPERCLIP_API_KEY: "bridge-fake-token-0003",
  QUOTED: "it's a 'quoted' value",
  MULTILINE: "line one\nline two\n",
  SHELLY: `$(touch '${INJECTION_MARKER}') \`touch '${INJECTION_MARKER}'\` $HOME \\n %s`,
  CRLF: "crlf\r\nvalue\r",
  BIG: "b".repeat(64 * 1024),
  XDG_CONFIG_HOME: "/tmp/cfg",
};

// Build the exec request path exactly as @kubernetes/client-node does for a
// command, without a cluster: a fake WebSocket handler captures the path.
async function execRequestPath(command: string[]): Promise<string> {
  let captured = "";
  const handler = {
    connect: async (path: string) => {
      captured = path;
      return { close() {} } as never;
    },
  };
  const exec = new Exec({} as KubeConfig, handler as never);
  await exec.exec("ns", "pod", "agent", command, new PassThrough(), new PassThrough(), new PassThrough(), false);
  return captured;
}

// Run the wrapped command under the local /bin/sh exactly as execInPod would:
// with a stdin payload, the argv is the `head -c <N> | ...` bound around it.
function runWrapped(command: string[], env: Record<string, string>, stdin?: string) {
  const wrapped = wrapCommandWithEnv(command, env, stdin);
  const payload =
    wrapped.stdin === undefined ? undefined
    : Buffer.isBuffer(wrapped.stdin) ? wrapped.stdin
    : Buffer.from(wrapped.stdin, "utf-8");
  const [file, ...args] = payload && payload.length > 0 ? boundCommandToStdin(wrapped.command, payload) : wrapped.command;
  return spawnSync(file!, args, {
    input: payload,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    encoding: "utf-8",
  });
}

afterAll(() => rmSync(MARKER_DIR, { recursive: true, force: true }));

describe("boundCommandToStdin", () => {
  it("bounds stdin by its UTF-8 byte length and quotes every argument", () => {
    const payload = Buffer.from("é✓\n", "utf-8");
    expect(payload.length).toBe(6);
    expect(boundCommandToStdin(["/bin/sh", "-c", "echo 'x'"], payload)).toEqual([
      "/bin/sh",
      "-c",
      "head -c 6 | '/bin/sh' '-c' 'echo '\\''x'\\'''",
    ]);
  });
});

describe("wrapCommandWithEnv", () => {
  it("returns the command and stdin unchanged when there is no env", () => {
    expect(wrapCommandWithEnv(["opencode", "run"], undefined)).toEqual({ command: ["opencode", "run"], stdin: undefined });
    expect(wrapCommandWithEnv(["opencode", "run"], {}, "in")).toEqual({ command: ["opencode", "run"], stdin: "in" });
  });

  it("never puts an env value in the exec argv", () => {
    const { command } = wrapCommandWithEnv(["opencode", "run", "--model", "anthropic/x"], SECRET_ENV);
    const argv = command.join("\u0000");
    for (const value of Object.values(SECRET_ENV)) {
      expect(argv).not.toContain(value);
      for (const line of value.split("\n").filter((l) => l.length >= 4)) {
        expect(argv).not.toContain(line);
      }
    }
    expect(command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(command[2]).toContain("exec 'opencode' 'run' '--model' 'anthropic/x'");
  });

  it("never puts an env value in the Kubernetes exec request URI", async () => {
    const { command } = wrapCommandWithEnv(["opencode", "run"], SECRET_ENV);
    const uri = await execRequestPath(command);
    expect(uri).toMatch(/^\/api\/v1\/namespaces\/ns\/pods\/pod\/exec\?/);
    const decoded = decodeURIComponent(uri.replace(/\+/g, " "));
    for (const value of Object.values(SECRET_ENV)) {
      expect(uri).not.toContain(value);
      expect(uri).not.toContain(encodeURIComponent(value));
      expect(decoded).not.toContain(value);
    }
    // Sanity check of the harness: the old shape (values in argv) is visible.
    const leaky = await execRequestPath(["/bin/sh", "-c", `export K='${SECRET_ENV.RAMP_ROUTER_API_KEY}'; exec x`]);
    expect(leaky).toContain(SECRET_ENV.RAMP_ROUTER_API_KEY);
  });

  it("delivers the env values over stdin, ahead of the caller's stdin", () => {
    const { stdin } = wrapCommandWithEnv(["opencode"], { ANTHROPIC_API_KEY: "sk-fake" }, "prompt body");
    const text = Buffer.isBuffer(stdin) ? stdin.toString("utf-8") : String(stdin);
    expect(text).toBe("export ANTHROPIC_API_KEY='sk-fake';\nprompt body");
  });

  it("exports the exact values in a real shell and passes the caller's stdin through", () => {
    const result = runWrapped(
      [
        "/bin/sh",
        "-c",
        'printf "[%s]" "$RAMP_ROUTER_API_KEY" "$QUOTED" "$MULTILINE" "$SHELLY" "$CRLF" "$BIG" "$XDG_CONFIG_HOME" "$(cat)"',
      ],
      SECRET_ENV,
      "prompt line 1\r\nprompt line 2",
    );
    expect(result.status).toBe(0);
    expect(existsSync(INJECTION_MARKER)).toBe(false);
    expect(result.stdout).toBe(
      [
        SECRET_ENV.RAMP_ROUTER_API_KEY,
        SECRET_ENV.QUOTED,
        SECRET_ENV.MULTILINE,
        SECRET_ENV.SHELLY,
        SECRET_ENV.CRLF,
        SECRET_ENV.BIG,
        "/tmp/cfg",
        "prompt line 1\r\nprompt line 2",
      ].map((v) => `[${v}]`).join(""),
    );
  });

  it("gives the command an empty stdin when the caller supplied none", () => {
    const result = runWrapped(["/bin/sh", "-c", 'printf "%s|%s" "$V" "$(cat)"'], { V: "v" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("v|");
  });

  it("propagates the command's exit code", () => {
    const result = runWrapped(["/bin/sh", "-c", "exit 7"], { V: "v" });
    expect(result.status).toBe(7);
  });

  it("never propagates PATH (would break command resolution in the sandbox image)", () => {
    const { stdin } = wrapCommandWithEnv(["opencode"], { PATH: "/server/bin", XDG_CONFIG_HOME: "/c" });
    expect(String(stdin)).not.toContain("PATH=");
    expect(String(stdin)).toContain("XDG_CONFIG_HOME=");
  });

  it("skips invalid identifiers and non-string values", () => {
    const { command, stdin } = wrapCommandWithEnv(["opencode"], {
      "BAD-KEY": "x",
      GOOD_KEY: "y",
      // @ts-expect-error intentional non-string to exercise the guard
      NUMERIC: 5,
    });
    expect(String(stdin)).toContain("export GOOD_KEY='y';");
    expect(String(stdin)).not.toContain("BAD-KEY");
    expect(String(stdin)).not.toContain("NUMERIC");
    expect(command.join(" ")).not.toContain("GOOD_KEY");
  });

  it("delivers a maximum-size Hermes system prompt (131040 bytes, multi-line, UTF-8) intact (TECH-8174)", () => {
    // HERMES_MAX_SYSTEM_PROMPT_BYTES in the Hermes adapter (packages/adapters/hermes execute.ts):
    // 128 KiB minus the env entry overhead. Kept literal: this plugin does not depend on the adapter.
    const unit = "Line with 'quotes', $VARS, `ticks` and é✓\n";
    let prompt = "";
    while (Buffer.byteLength(prompt + unit, "utf-8") <= 131040) prompt += unit;
    prompt += "x".repeat(131040 - Buffer.byteLength(prompt, "utf-8"));
    expect(Buffer.byteLength(prompt, "utf-8")).toBe(131040);
    const { command } = wrapCommandWithEnv(["hermes"], { HERMES_EPHEMERAL_SYSTEM_PROMPT: prompt });
    expect(command.join(" ")).not.toContain("Line with");
    const result = runWrapped(
      ["/bin/sh", "-c", 'printf "%s|%s" "$HERMES_EPHEMERAL_SYSTEM_PROMPT" "$(cat)"'],
      { HERMES_EPHEMERAL_SYSTEM_PROMPT: prompt },
      "query text on stdin\n",
    );
    expect(result.status).toBe(0);
    // The env value arrives intact and the caller's stdin still follows the env line.
    expect(result.stdout).toBe(`${prompt}|query text on stdin`);
  });
});
