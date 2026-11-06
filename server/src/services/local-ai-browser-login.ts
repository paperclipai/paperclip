import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { runSetupTokenLogin } from "@paperclipai/adapter-claude-local/server";
import { runDeviceLogin } from "@paperclipai/adapter-codex-local/server";
import { ensureCommandResolvable, resolveCommandForLogs } from "@paperclipai/adapter-utils/server-utils";
import { resolveCodexCommand, startAntigravityBrowserLogin } from "../vendor/paperclip-runner/index.js";

export type LocalBrowserLoginState = {
  authorizationUrl?: string;
  code?: string;
  outcome?: "success" | "failure";
  error?: string;
  submitCode?: (code: string) => void;
  abort: () => Promise<void>;
};

// Unix uses the existing Python PTY bridge. Windows has no Python `pty` module;
// its interactive Claude and Codex login processes instead use native ConPTY
// through node-pty. Neither transport logs the provider's secret-bearing output.
const PYTHON_PTY_BRIDGE = String.raw`
import errno, os, pty, select, signal, sys
pid, master = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
def stop(_signal, _frame):
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    sys.exit(1)
signal.signal(signal.SIGTERM, stop)
while True:
    readable, _, _ = select.select([master, 0], [], [])
    if 0 in readable:
        data = os.read(0, 4096)
        if data: os.write(master, data)
        else: stop(None, None)
    if master in readable:
        try: data = os.read(master, 4096)
        except OSError as error:
            if error.errno == errno.EIO: break
            raise
        if not data: break
        os.write(1, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

/** Run the same browser-code login used by sandbox connections on the local host. */
export function startLocalBrowserLogin(provider: "anthropic" | "openai" | "google", home: string): LocalBrowserLoginState {
  if (provider === "google") return startAntigravityBrowserLogin(home);
  const controller = new AbortController();
  let runnerFinished: Promise<void> = Promise.resolve();
  const state: LocalBrowserLoginState = { abort: async () => { controller.abort(); await runnerFinished; } };
  const args = provider === "anthropic" ? ["setup-token"] : ["login", "--device-auth"];
  let child: ChildProcessWithoutNullStreams | null = null;
  type WindowsPty = {
    kill(): void;
    write(data: string): void;
    onData(listener: (data: string) => void): unknown;
    onExit(listener: (event: { exitCode: number }) => void): unknown;
    on?(event: string, listener: () => void): void;
  };
  let windowsPty: WindowsPty | null = null;
  let activeProcessExit: Promise<void> = Promise.resolve();
  let stopped = false;
  const stop = () => {
    stopped = true;
    const pty = windowsPty;
    windowsPty = null;
    try { pty?.kill(); } catch { /* Already exited. */ }
    const c = child;
    child = null;
    try { c?.kill("SIGTERM"); } catch { /* Already exited. */ }
  };
  const driver = {
    async start(_command: string, onData: (chunk: string) => void): Promise<{ exitCode: number | null }> {
      let executable = "claude";
      if (provider === "anthropic" && process.platform === "win32") {
        try {
          await ensureCommandResolvable("claude", home, process.env);
          executable = path.win32.resolve(home, await resolveCommandForLogs("claude", home, process.env));
        } catch {
          state.error = "Claude browser sign-in requires the Claude CLI on this execution host. Install Claude Code and ensure claude.cmd is on Paperclip's PATH, then start sign-in again.";
          throw new Error("Browser login runtime unavailable");
        }
      }
      if (provider === "openai") {
        const legacyPlatform = !((process.platform === "linux" || process.platform === "darwin")
          && (process.arch === "x64" || process.arch === "arm64"));
        try {
          if (legacyPlatform) {
            await ensureCommandResolvable("codex", home, process.env);
            const pathApi = process.platform === "win32" ? path.win32 : path;
            executable = pathApi.resolve(home, await resolveCommandForLogs("codex", home, process.env));
          } else {
            executable = resolveCodexCommand();
          }
        } catch {
          state.error = legacyPlatform
            ? "Codex browser sign-in requires the Codex CLI on this platform. Install Codex on this execution host and ensure codex is on Paperclip's PATH, then start sign-in again."
            : "Codex browser sign-in requires an installed Codex CLI. Install Codex on this execution host or restore Paperclip's runtime dependencies, then start sign-in again.";
          throw new Error("Browser login runtime unavailable");
        }
      }
      if (controller.signal.aborted || stopped) throw new Error("Local sign-in cancelled before launch");
      const env = { ...process.env,
        ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "",
        OPENAI_API_KEY: "", CODEX_API_KEY: "",
        CLAUDE_CONFIG_DIR: provider === "anthropic" ? home : process.env.CLAUDE_CONFIG_DIR,
        CODEX_HOME: provider === "openai" ? home : process.env.CODEX_HOME,
        BROWSER: "true",
      };
      if (process.platform === "win32") {
        // A ConPTY is required: piping stdin/stdout to `claude setup-token` is
        // not equivalent to an interactive terminal. Only fixed provider args
        // are passed; never interpolate a browser code or a token into a shell.
        let nodePty: {
          spawn(file: string, args: string[], options: {
            name: string; cols: number; rows: number; cwd: string; env: Record<string, string>;
          }): WindowsPty;
        };
        try {
          const optionalDependency = "node-pty";
          nodePty = await import(optionalDependency) as typeof nodePty;
        } catch {
          state.error = "Windows browser sign-in needs the node-pty ConPTY dependency. Reinstall Paperclip and start sign-in again.";
          throw new Error("Windows login terminal unavailable");
        }
        if (controller.signal.aborted || stopped) {
          throw new Error("Local sign-in cancelled before launch");
        }
        const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
        const command = `& ${quoted(executable)} ${args.map(quoted).join(" ")}`;
        // EncodedCommand avoids another command-line quoting layer on Windows.
        const encoded = Buffer.from(command, "utf16le").toString("base64");
        const ptyEnv = Object.fromEntries(
          Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
        const processExit = new Promise<{ exitCode: number | null }>((resolve, reject) => {
          if (controller.signal.aborted || stopped) {
            reject(new Error("Local sign-in cancelled"));
            return;
          }
          try {
            windowsPty = nodePty.spawn("powershell.exe",
              ["-NoLogo", "-NoProfile", "-EncodedCommand", encoded],
              { name: "xterm-256color", cols: 120, rows: 30, cwd: process.cwd(), env: ptyEnv });
            windowsPty.on?.("error", () => {
              /* Ignore socket errors during teardown */
            });
            windowsPty.onData(onData);
            windowsPty.onExit(({ exitCode }) => resolve({ exitCode }));
            if (controller.signal.aborted || stopped) stop();
          } catch {
            state.error = "Windows could not start an interactive ConPTY session. Check the installed node-pty binary and Claude/Codex CLI.";
            reject(new Error("Windows ConPTY startup failed"));
          }
        });
        activeProcessExit = processExit.then(() => undefined, () => undefined);
        return processExit;
      }
      const processExit = new Promise<{ exitCode: number | null }>((resolve, reject) => {
        child = spawn("python3", ["-u", "-c", PYTHON_PTY_BRIDGE, executable, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.on("data", (bytes: Buffer) => onData(bytes.toString("utf8")));
        // Provider output may contain secrets. Never log or retain stderr.
        child.stderr.resume();
        child.once("error", () => {
          state.error = "Browser sign-in requires Python 3 and a working local terminal. Install Python 3 on this execution host, then start sign-in again.";
          reject(new Error("Browser login terminal unavailable"));
        });
        child.once("close", (exitCode) => resolve({ exitCode }));
      });
      activeProcessExit = processExit.then(() => undefined, () => undefined);
      return processExit;
    },
    write(input: string) {
      try {
        if (windowsPty) windowsPty.write(input);
        else child?.stdin.write(input);
      } catch {
        /* Process may have already exited. */
      }
    },
    stop,
    async dispose() { stop(); await activeProcessExit; },
    async readFile(file: string) { const { readLocalAiCredentialFile } = await import("./local-ai-credential-file.js"); return Buffer.from(await readLocalAiCredentialFile(file)); },
  };
  if (provider === "anthropic") {
    let deliverCode: ((code: string) => void) | undefined;
    const codeReady = new Promise<string>((resolve) => { deliverCode = resolve; });
    state.submitCode = (code) => { deliverCode?.(code); deliverCode = undefined; };
    runnerFinished = runSetupTokenLogin(driver, {
      timeoutMs: 300_000, signal: controller.signal,
      onPrompt: (prompt) => { state.authorizationUrl = prompt.url; },
      provideCode: (signal) => new Promise<string>((resolve, reject) => {
        const abort = () => reject(new Error("Local sign-in cancelled"));
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
        codeReady.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      }),
      onCredential: async (bytes) => {
        const file = await open(path.join(home, ".credentials.json"),
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
        try {
          await file.writeFile(JSON.stringify({ claudeAiOauth: { accessToken: bytes.toString("utf8") } }));
        } finally {
          await file.close();
        }
      },
    }).then((result) => { state.outcome = result.outcome === "success" ? "success" : "failure"; })
      .catch(() => { state.outcome = "failure"; });
  } else {
    runnerFinished = runDeviceLogin(driver, {
      timeoutMs: 300_000, signal: controller.signal,
      onPrompt: (prompt) => { state.authorizationUrl = prompt.url; state.code = prompt.code; },
    }).then((result) => { state.outcome = result.outcome === "success" ? "success" : "failure"; })
      .catch(() => { state.outcome = "failure"; });
  }
  return state;
}
