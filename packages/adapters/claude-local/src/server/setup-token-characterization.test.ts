import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  parseSetupTokenPrompt,
  SETUP_TOKEN_AUTH_URLS,
  SETUP_TOKEN_PROMPT,
  SETUP_TOKEN_URL_QUERY_KEYS,
} from "./setup-token-parse.js";

// The live characterization of `claude setup-token`. This suite runs the real
// Claude Code login command in a real pseudo-terminal, captures the sign-in
// prompt output, and confirms the parser reads the real terminal contract. It
// records the tested Claude Code version. It fails loudly on a parse miss, so a
// terminal-contract drift breaks the suite instead of passing silently.
//
// The suite is opt-in. It needs the real `claude` binary, `python3` for the
// pseudo-terminal, and network access to claude.com to mint the authorization
// URL, so it never runs in a normal or a continuous-integration test run. Set
// `RUN_CLAUDE_SETUP_TOKEN_CHARACTERIZATION=1` to run it in a real sandbox.
//
// Security: the suite drives only the prompt phase. It never submits a browser
// code, so the command never mints a token. It parses the captured bytes in
// memory and asserts only the non-secret shape (the URL origin, the URL path,
// the URL query keys, and the constant prompt). It never writes the captured
// bytes, the real authorization URL, or any token to a durable file, a log, or
// an assertion message.

const OPT_IN = process.env.RUN_CLAUDE_SETUP_TOKEN_CHARACTERIZATION === "1";

// A pseudo-terminal harness. It runs `claude setup-token` on a real
// pseudo-terminal with a wide window, streams the raw terminal bytes to its own
// standard output, and stops when it sees the prompt phrase or after a timeout.
// It never submits a code, so the command never mints a token.
const PTY_HARNESS = `
import os, pty, sys, select, time, fcntl, termios, struct, signal
duration = float(os.environ.get("STCHAR_DURATION", "40"))
cols, rows = 200, 50
pid, fd = pty.fork()
if pid == 0:
    os.execvp("claude", ["claude", "setup-token"])
    os._exit(127)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
acc = b""
start = time.time()
try:
    while time.time() - start < duration:
        r, _, _ = select.select([fd], [], [], 0.5)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            acc += data
            os.write(1, data)
            if b"Paste code here if prompted" in acc:
                break
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
`;

function hasCommand(command: string): boolean {
  const probe = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  return probe.status === 0;
}

function readClaudeVersion(): string {
  const raw = execFileSync("claude", ["--version"], { encoding: "utf8" });
  // The version line reads like `2.1.226 (Claude Code)`. Read the leading
  // semantic version.
  const match = raw.match(/(\d+\.\d+\.\d+)/);
  if (!match) throw new Error("could not read the Claude Code version");
  return match[1];
}

// Removes the terminal control sequences the same way the parser does, so the
// test can assert on the rendered banner text. It keeps this local, so the test
// never imports a parser internal.
function renderForBanner(raw: string): string {
  return raw
    // OSC sequences (hyperlinks and other OSC), BEL or ST terminated.
    .replace(/\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)/g, "")
    // Horizontal-move CSI sequences render as one space.
    .replace(/\x1b\[[0-9;]*[GC]/g, " ")
    // Any remaining CSI sequence.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

const run = OPT_IN ? describe : describe.skip;

run("claude setup-token live characterization", () => {
  it(
    "reads the real sign-in prompt contract and records the Claude Code version",
    () => {
      expect(hasCommand("claude"), "the claude binary must be installed").toBe(true);
      expect(hasCommand("python3"), "python3 must be installed for the pseudo-terminal").toBe(true);

      const version = readClaudeVersion();

      const result = spawnSync("python3", ["-c", PTY_HARNESS], {
        encoding: "buffer",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, STCHAR_DURATION: "40" },
      });
      if (result.error) throw result.error;
      const raw = (result.stdout ?? Buffer.alloc(0)).toString("utf8");

      // Fail loudly on a parse miss. A terminal-contract drift breaks the suite
      // here instead of passing silently.
      const parsed = parseSetupTokenPrompt(raw);
      expect(parsed, "the parser did not read the live setup-token prompt").not.toBeNull();

      const url = new URL(parsed!.url);
      // The live CLI emits one of the two accepted origin-and-path pairs. The
      // installed version decides which pair the run records.
      expect(SETUP_TOKEN_AUTH_URLS).toContain(`${url.origin}${url.pathname}`);
      expect([...url.searchParams.keys()].sort()).toEqual([...SETUP_TOKEN_URL_QUERY_KEYS].sort());
      expect(url.hash).toBe("");
      expect(parsed!.prompt).toBe(SETUP_TOKEN_PROMPT);

      // The banner names the tested Claude Code version. This ties the recorded
      // contract to the version that produced it.
      const banner = renderForBanner(raw);
      expect(banner).toContain(`Claude Code v${version}`);

      // Record the tested version and the non-secret anchors. The reporter shows
      // this line; it names no secret.
      // eslint-disable-next-line no-console
      console.log(
        `[characterization] Claude Code v${version}: prompt "${SETUP_TOKEN_PROMPT}", ` +
          `URL ${url.origin}${url.pathname} with query keys ` +
          `[${[...SETUP_TOKEN_URL_QUERY_KEYS].join(", ")}].`,
      );
    },
    60_000,
  );
});
