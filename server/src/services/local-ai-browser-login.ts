import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { runSetupTokenLogin } from "@paperclipai/adapter-claude-local/server";
import { runDeviceLogin } from "@paperclipai/adapter-codex-local/server";
import { ensureCommandResolvable, resolveCommandForLogs, resolveWindowsConsoleCommand } from "@paperclipai/adapter-utils/server-utils";
import { resolveCodexCommand, startAntigravityBrowserLogin } from "../vendor/paperclip-runner/index.js";

export type LocalBrowserLoginState = {
  authorizationUrl?: string;
  code?: string;
  outcome?: "success" | "failure";
  error?: string;
  submitCode?: (code: string) => void;
  abort: () => void;
};

// Node has no built-in PTY API. Python's standard-library pty module supplies
// the terminal required by both CLIs. The Docker image already includes
// python3. This bridge forwards only bytes; provider output is never logged.
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

// Windows has no pty module. This bridge keeps the same byte-forwarding shape
// but runs the CLI under a ConPTY through the pywinpty package. It receives the
// application and its parameter string already quoted for the console host, so
// a .cmd wrapper and a path with spaces reach the CLI unchanged. A missing
// pywinpty exits with a fixed code that names the prerequisite without reading
// provider output.
const WINDOWS_BRIDGE_MISSING_EXIT_CODE = 97;
// cmd.exe and the Microsoft Store "python" alias both exit with this code when
// the command is not installed.
const WINDOWS_COMMAND_NOT_FOUND_EXIT_CODE = 9009;
const WINDOWS_TERMINAL_PREREQUISITE =
  "Browser sign-in requires Python 3 with the pywinpty package on this host. Install Python 3, run python -m pip install pywinpty, then start sign-in again.";
const WINDOWS_CONPTY_BRIDGE = String.raw`
import os, sys, threading
try:
    from winpty import PTY, PtyProcess
except ImportError:
    sys.exit(97)
terminal = PTY(500, 50)
environment = "\0".join("%s=%s" % item for item in os.environ.items()) + "\0"
terminal.spawn(sys.argv[1], cwd=os.getcwd(), env=environment, cmdline=" " + sys.argv[2])
proc = PtyProcess(terminal)
def pump_stdin():
    stdin = sys.stdin.buffer
    while True:
        data = stdin.read1(4096)
        if not data: break
        try: proc.write(data.decode("utf-8", "replace"))
        except Exception: break
    try: proc.terminate(True)
    except Exception: pass
    os._exit(1)
threading.Thread(target=pump_stdin, daemon=True).start()
out = sys.stdout.buffer
while True:
    try: chunk = proc.read(4096)
    except EOFError: break
    if not chunk:
        if not proc.isalive(): break
        continue
    out.write(chunk.encode("utf-8", "replace"))
    out.flush()
proc.wait()
out.flush()
# The stdin pump blocks in a read; interpreter shutdown would wait on its
# buffer lock, so leave without finalizing.
os._exit(proc.exitstatus if proc.exitstatus is not None else 1)
`;

/** Run the same browser-code login used by sandbox connections on the local host. */
export function startLocalBrowserLogin(provider: "anthropic" | "openai" | "google", home: string): LocalBrowserLoginState {
  if (provider === "google") return startAntigravityBrowserLogin(home);
  const controller = new AbortController();
  const state: LocalBrowserLoginState = { abort: () => controller.abort() };
  const args = provider === "anthropic" ? ["setup-token"] : ["login", "--device-auth"];
  let child: ChildProcessWithoutNullStreams | null = null;
  const driver = {
    async start(_command: string, onData: (chunk: string) => void): Promise<{ exitCode: number | null }> {
      let executable = provider === "anthropic" ? "claude" : "codex";
      if (provider === "openai" && process.platform !== "win32") {
        const legacyPlatform = !((process.platform === "linux" || process.platform === "darwin")
          && (process.arch === "x64" || process.arch === "arm64"));
        try {
          if (legacyPlatform) {
            await ensureCommandResolvable("codex", home, process.env);
            executable = path.resolve(home, await resolveCommandForLogs("codex", home, process.env));
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
      if (controller.signal.aborted) throw new Error("Local sign-in cancelled before launch");
      const env = { ...process.env,
        ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "",
        OPENAI_API_KEY: "", CODEX_API_KEY: "",
        CLAUDE_CONFIG_DIR: provider === "anthropic" ? home : process.env.CLAUDE_CONFIG_DIR,
        CODEX_HOME: provider === "openai" ? home : process.env.CODEX_HOME,
        BROWSER: "true",
      };
      let bridge = { command: "python3", args: ["-u", "-c", PYTHON_PTY_BRIDGE, executable, ...args] };
      if (process.platform === "win32") {
        const consoleCommand = await resolveWindowsConsoleCommand(executable, args, home, env);
        if (!consoleCommand) {
          state.error = provider === "anthropic"
            ? "Claude browser sign-in requires the Claude Code CLI on this platform. Install Claude Code on this execution host and ensure claude is on Paperclip's PATH, then start sign-in again."
            : "Codex browser sign-in requires the Codex CLI on this platform. Install Codex on this execution host and ensure codex is on Paperclip's PATH, then start sign-in again.";
          throw new Error("Browser login runtime unavailable");
        }
        // Windows installs expose "python"; "python3" is usually only the Store alias.
        bridge = { command: "python", args: ["-u", "-c", WINDOWS_CONPTY_BRIDGE, consoleCommand.application, consoleCommand.parameters] };
      }
      return new Promise((resolve, reject) => {
        child = spawn(bridge.command, bridge.args, { env, stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.on("data", (bytes: Buffer) => onData(bytes.toString("utf8")));
        // Provider output may contain secrets. Never log or retain stderr.
        child.stderr.resume();
        child.once("error", () => {
          state.error = process.platform === "win32"
            ? WINDOWS_TERMINAL_PREREQUISITE
            : "Browser sign-in requires Python 3 and a working local terminal. Install Python 3 on this execution host, then start sign-in again.";
          reject(new Error("Browser login terminal unavailable"));
        });
        child.once("close", (exitCode) => {
          if (process.platform === "win32"
            && (exitCode === WINDOWS_BRIDGE_MISSING_EXIT_CODE || exitCode === WINDOWS_COMMAND_NOT_FOUND_EXIT_CODE)) {
            state.error = WINDOWS_TERMINAL_PREREQUISITE;
          }
          resolve({ exitCode });
        });
      });
    },
    write(input: string) { child?.stdin.write(input); },
    stop() { child?.kill("SIGTERM"); },
    async dispose() { child?.kill("SIGTERM"); },
    async readFile(file: string) { const { readLocalAiCredentialFile } = await import("./local-ai-credential-file.js"); return Buffer.from(await readLocalAiCredentialFile(file)); },
  };
  if (provider === "anthropic") {
    let deliverCode: ((code: string) => void) | undefined;
    const codeReady = new Promise<string>((resolve) => { deliverCode = resolve; });
    state.submitCode = (code) => { deliverCode?.(code); deliverCode = undefined; };
    void runSetupTokenLogin(driver, {
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
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
          await file.writeFile(JSON.stringify({ claudeAiOauth: { accessToken: bytes.toString("utf8") } }));
        } finally {
          await file.close();
        }
      },
    }).then((result) => { state.outcome = result.outcome === "success" ? "success" : "failure"; })
      .catch(() => { state.outcome = "failure"; });
  } else {
    void runDeviceLogin(driver, {
      timeoutMs: 300_000, signal: controller.signal,
      onPrompt: (prompt) => { state.authorizationUrl = prompt.url; state.code = prompt.code; },
    }).then((result) => { state.outcome = result.outcome === "success" ? "success" : "failure"; })
      .catch(() => { state.outcome = "failure"; });
  }
  return state;
}
