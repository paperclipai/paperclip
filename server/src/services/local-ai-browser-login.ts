import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { runSetupTokenLogin } from "@paperclipai/adapter-claude-local/server";
import { runDeviceLogin } from "@paperclipai/adapter-codex-local/server";
import { ensureCommandResolvable, resolveCommandForLogs } from "@paperclipai/adapter-utils/server-utils";
import { resolveCodexCommand, startAntigravityBrowserLogin } from "../vendor/paperclip-runner/index.js";
import { logger } from "../middleware/logger.js";

export type LocalBrowserLoginState = {
  authorizationUrl?: string;
  code?: string;
  outcome?: "success" | "failure";
  error?: string;
  submitCode?: (code: string) => void;
  submitRedirect?: (rawRedirectUrl: string) => Promise<void>;
  abort: () => void | Promise<void>;
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

/**
 * ConPTY redraws with absolute cursor moves and skips cells that already hold
 * the right character, so its raw stream is not line text. This is a minimal
 * terminal screen: it applies cursor moves, erases, and carriage returns to a
 * character grid, writes each OSC 8 hyperlink's URI on its own line, and ignores
 * styling. `render()` returns the screen as plain lines, which the login parsers
 * read. It buffers a trailing partial escape sequence until the next chunk.
 */
export function createConptyScreen(viewportRows = 30): { write(chunk: string): void; render(): string } {
  const rows: string[][] = [[]];
  let row = 0;
  let col = 0;
  let top = 0;
  let pending = "";
  let linkOpen = false;
  // eslint-disable-next-line no-control-regex
  const partialTail = /\u001b(?:\](?:[^\u001b\u0007]|\u001b(?!\\))*|\[[0-?]*[ -/]*)?$/;
  // eslint-disable-next-line no-control-regex
  const csi = /^\u001b\[([0-?]*)[ -/]*([@-~])/;
  // eslint-disable-next-line no-control-regex
  const osc = /^\u001b\]([^\u001b\u0007]*)(?:\u0007|\u001b\\)/;
  const line = (r: number) => { while (rows.length <= r) rows.push([]); return rows[r]!; };
  const moveTo = (r: number, c: number) => { row = Math.max(0, r); col = Math.max(0, c); line(row); if (row - top >= viewportRows) top = row - viewportRows + 1; };
  const put = (ch: string) => {
    const cells = line(row);
    while (cells.length < col) cells.push(" ");
    cells[col++] = ch;
  };
  const eraseLine = (mode: number) => {
    const cells = line(row);
    if (mode === 0) cells.length = Math.min(cells.length, col);
    else if (mode === 1) for (let i = 0; i <= col && i < cells.length; i++) cells[i] = " ";
    else cells.length = 0;
  };
  const control = (params: string, final: string) => {
    const n = params.split(";").map((part) => Number.parseInt(part, 10));
    const first = Number.isNaN(n[0]!) ? undefined : n[0]!;
    switch (final) {
      case "H": case "f": moveTo(top + (first ?? 1) - 1, (Number.isNaN(n[1]!) || n[1] === undefined ? 1 : n[1]) - 1); break;
      case "A": moveTo(row - (first ?? 1), col); break;
      case "B": moveTo(row + (first ?? 1), col); break;
      case "C": col += Math.min(first ?? 1, 500); break;
      case "D": col = Math.max(0, col - (first ?? 1)); break;
      case "G": col = Math.max(0, (first ?? 1) - 1); break;
      case "d": moveTo(top + (first ?? 1) - 1, col); break;
      case "K": eraseLine(first ?? 0); break;
      case "J": if ((first ?? 0) >= 2) for (let r = top; r < rows.length; r++) rows[r] = []; break;
      default: break;
    }
  };
  return {
    write(chunk) {
      let text = pending + chunk;
      pending = "";
      const tail = partialTail.exec(text);
      if (tail && tail[0].length <= 4096) { pending = tail[0]; text = text.slice(0, tail.index); }
      for (let i = 0; i < text.length;) {
        const ch = text[i]!;
        if (ch === "\u001b") {
          const rest = text.slice(i);
          const c = csi.exec(rest);
          if (c) { control(c[1]!, c[2]!); i += c[0].length; continue; }
          const o = osc.exec(rest);
          if (o) {
            const link = /^8;[^;]*;(.*)$/s.exec(o[1]!);
            if (link) {
              linkOpen = link[1]!.length > 0;
              if (linkOpen) {
                if (col > 0) moveTo(row + 1, 0);
                for (const uriChar of link[1]!) put(uriChar);
              }
            }
            i += o[0].length;
            continue;
          }
          i += 2; // other two-character escapes, e.g. ESC = or ESC >
          continue;
        }
        i++;
        if (ch === "\r") col = 0;
        else if (ch === "\n") { if (!linkOpen) moveTo(row + 1, col); }
        else if (ch === "\b") col = Math.max(0, col - 1);
        else if (ch >= " " && !linkOpen) put(ch);
      }
    },
    render() {
      const lines = rows.map((cells) => cells.join("").trimEnd());
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      return lines.join("\n");
    },
  };
}

/** Streams only the screen text that changed since the last emit. */
export function createScreenEmitter(screen: { render(): string }, emit: (chunk: string) => void): () => void {
  let last = "";
  return () => {
    const next = screen.render();
    if (next === last) return;
    if (next.startsWith(last)) emit(next.slice(last.length));
    else {
      let p = 0;
      while (p < last.length && last[p] === next[p]) p++;
      emit("\n" + next.slice(next.lastIndexOf("\n", p - 1) + 1));
    }
    last = next;
  };
}

/** Run the same browser-code login used by sandbox connections on the local host. */
export function startLocalBrowserLogin(provider: "anthropic" | "openai" | "google", home: string): LocalBrowserLoginState {
  if (provider === "google") {
    return startAntigravityBrowserLogin(home, {
      onFailure: (reason) => {
        if (reason !== "aborted") logger.warn({ code: `ANTIGRAVITY_SIGN_IN_${reason.toUpperCase()}` }, "Google Antigravity sign-in failed");
      },
    });
  }
  const controller = new AbortController();
  const state: LocalBrowserLoginState = { abort: () => controller.abort() };
  const args = provider === "anthropic" ? ["setup-token"] : ["login", "--device-auth"];
  let child: ChildProcessWithoutNullStreams | null = null;
  // Windows has no Python pty module, so a ConPTY session stands in for the bridge.
  let winPty: { write(input: string): void; kill(): void } | null = null;
  const driver = {
    async start(_command: string, onData: (chunk: string) => void): Promise<{ exitCode: number | null }> {
      let executable = "claude";
      if (provider === "openai") {
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
      if (process.platform === "win32") {
        const { spawn: spawnPty } = await import("@lydell/node-pty");
        const ptyEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(env)) if (typeof value === "string") ptyEnv[key] = value;
        let file = executable;
        let ptyArgs = args;
        if (provider === "anthropic") {
          try {
            await ensureCommandResolvable("claude", home, env);
            file = await resolveCommandForLogs("claude", home, env);
          } catch { file = "claude"; }
        }
        // ConPTY launches executables directly; npm shims (.cmd/.bat) need cmd.exe.
        if (/\.(cmd|bat)$/i.test(file)) {
          ptyArgs = ["/d", "/s", "/c", file, ...args];
          file = process.env.ComSpec ?? "cmd.exe";
        }
        return new Promise((resolve, reject) => {
          // Cleanup may already have run while the import or lookup above was pending.
          if (controller.signal.aborted) {
            reject(new Error("Local sign-in cancelled before launch"));
            return;
          }
          try {
            const session = spawnPty(file, ptyArgs, { name: "xterm-256color", cols: 120, rows: 30, cwd: home, env: ptyEnv });
            winPty = session;
            const screen = createConptyScreen();
            const emitChanges = createScreenEmitter(screen, onData);
            let timer: NodeJS.Timeout | undefined;
            session.onData((chunk: string) => {
              screen.write(chunk);
              clearTimeout(timer);
              timer = setTimeout(emitChanges, 60);
            });
            session.onExit(({ exitCode }: { exitCode: number }) => {
              clearTimeout(timer);
              emitChanges();
              resolve({ exitCode });
            });
          } catch {
            state.error = "Browser sign-in could not open a Windows terminal (ConPTY). Make sure the CLI is installed and on Paperclip's PATH, then start sign-in again.";
            reject(new Error("Browser login terminal unavailable"));
          }
        });
      }
      return new Promise((resolve, reject) => {
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
    },
    write(input: string) { if (winPty) winPty.write(input.replace(/\r?\n/g, "\r")); else child?.stdin.write(input); },
    stop() { if (winPty) winPty.kill(); else child?.kill("SIGTERM"); },
    async dispose() { if (winPty) winPty.kill(); else child?.kill("SIGTERM"); },
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
    }).then((result) => {
      state.outcome = result.outcome === "success" ? "success" : "failure";
      if (result.failureReason === "oauth_error") state.error = "Claude rejected the authorization code. Start sign-in again and use the code from the new sign-in tab.";
    })
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
