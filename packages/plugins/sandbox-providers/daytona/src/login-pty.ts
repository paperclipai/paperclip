// The Daytona pseudo-terminal (PTY) session for the shared login flow. The login
// command needs a real pseudo-terminal: pipe stdio emits no login prompt. The
// Daytona SDK opens a PTY through `process.createPty`. This module binds that PTY
// to a small session that the login PTY transport consumes, so the login runner
// runs the command on a real terminal, streams the terminal output, and delivers
// the delayed browser code plus the Enter byte.
//
// Command contract: the host resolves a closed login command key and a validated
// session home, and it carries them in a launch descriptor. The descriptor holds
// no command string. This module maps the key to a compile-time command, so a
// caller cannot select or override the command. For the Codex key the module
// composes `exec env CODEX_HOME=<encoded-home> <fixed-codex-command>`. For the
// Claude key it composes `exec <fixed-claude-command>` with no CODEX_HOME. The
// module encodes the dynamic home with a POSIX shell-argument encoder, so the
// home cannot add a second shell token or a second command.
//
// Session home: the module revalidates the descriptor and the home shape, then
// creates the exact UUID directory as a NEW directory with mode 0700, owned by the
// login user. The inspection and the creation open the filesystem root, then walk
// each path component with a no-follow, directory-only open, so a symlink at any
// ancestor (the login root or a directory above it) fails closed. A single
// composite `stat` or `mkdir` follows a symlink at an ancestor; the per-component
// walk does not. The creation creates the login root if the root is absent and the
// UUID directory as a NEW directory, both relative to an open trusted descriptor.
// The module rejects a pre-existing target, a symlink, a non-directory, a wrong
// owner, and a wrong mode. It uses no recursive delete. It re-checks the directory
// with a no-symlink walk before it opens the terminal and again before it sends the
// launch input, so a symlink swapped in after creation fails before the launch.
//
// Dependency boundary: this provider plugin ships standalone (the workspace
// excludes `packages/plugins/sandbox-providers/**`). So the module imports no
// workspace package. It declares the small session shape locally through
// {@link LoginPtySession}. The shape matches the `LoginPtySession` interface in
// `@paperclipai/adapter-utils`, so the transport factory `createLoginPtyTransport`
// accepts the session opener from this module with no adapter. The runner drives
// the transport; the transport drives this session.
//
// SDK boundary: the module holds no Daytona SDK type import. It declares the small
// subset of the SDK PTY and filesystem surfaces that it uses through
// {@link DaytonaPtyProcess}, {@link DaytonaPtyHandle}, and {@link DaytonaSandboxExec}.
// The SDK `Process` and `PtyHandle` satisfy those subsets, so a caller passes
// `sandbox.process` with no adapter. The narrow surface keeps the module
// unit-testable with a fake PTY and a fake filesystem.
//
// Security (secret handling): the login runner delivers the browser code and the
// Enter byte through {@link DaytonaPtyHandle.sendInput}. The SDK sends the input
// over the PTY socket, so the code never rides a command line and never reaches a
// process argument list. The session forwards the raw terminal bytes with no ANSI
// or OSC 8 handling; the login parser owns that handling.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sendPtyInputInChunks } from "./pty-chunked-input.js";

/**
 * The closed set of login command identities. The worker maps each key to a
 * compile-time command. A value outside this set fails closed before the module
 * touches the filesystem.
 */
export type LoginCommandKey = "claude" | "codex";

/**
 * The host-resolved launch descriptor. It carries the closed command key and the
 * server-controlled session home. It holds no command string.
 */
export interface LoginPtyLaunchDescriptor {
  /** The host-resolved fixed command identity. */
  loginCommandKey: LoginCommandKey;
  /**
   * The server-controlled session home. The shape is exact:
   * `/tmp/paperclip-adapter-login/<uuid>`.
   */
  sessionHome: string;
}

/**
 * The compile-time command for each login command key. The Daytona plugin ships
 * standalone, so it holds its own copy of the fixed commands. A future change to
 * a command lands here and in the adapter constant together.
 */
const LOGIN_COMMAND_BY_KEY: Readonly<Record<LoginCommandKey, string>> = {
  claude: "claude setup-token",
  codex: "codex login --device-auth",
};

/** The octal mode string for a new session home directory. */
const LOGIN_HOME_MODE = "700";

/** The fixed root for a login session home. */
const LOGIN_SESSION_HOME_ROOT = "/tmp/paperclip-adapter-login";

/**
 * The exact absolute path shape for a login session home. The path is the fixed
 * root, one slash, and one UUID. The anchors reject a relative path, a traversal,
 * whitespace, a control character, and a shell metacharacter, because none of
 * those match the UUID or the fixed root.
 */
const SESSION_HOME_PATTERN =
  /^\/tmp\/paperclip-adapter-login\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The fixed non-secret error a rejected launch descriptor or session home returns. */
export const LOGIN_PTY_DESCRIPTOR_REJECTED = "LOGIN_PTY_DESCRIPTOR_REJECTED";
/** The fixed non-secret error a rejected session home directory returns. */
export const LOGIN_PTY_HOME_REJECTED = "LOGIN_PTY_HOME_REJECTED";

/**
 * Encodes one value as a single POSIX shell argument. It wraps the value in
 * single quotes and escapes each embedded single quote. The shell treats every
 * other character inside single quotes as a literal, so an encoded value cannot
 * add a second shell token or a second command.
 */
export function encodePosixShellArg(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/** Reports whether a value is a member of the closed login command key set. */
export function isLoginCommandKey(value: unknown): value is LoginCommandKey {
  return value === "claude" || value === "codex";
}

/**
 * Composes the launch line for the descriptor. For the Codex key it prefixes one
 * safely encoded `CODEX_HOME` assignment with `env`. For the Claude key it adds no
 * `CODEX_HOME`. It replaces the interactive shell with the command through `exec`,
 * so the pseudo-terminal runs the command directly and its exit code becomes the
 * PTY exit code.
 */
export function composeLaunchLine(descriptor: LoginPtyLaunchDescriptor): string {
  const command = LOGIN_COMMAND_BY_KEY[descriptor.loginCommandKey];
  if (descriptor.loginCommandKey === "codex") {
    const encodedHome = encodePosixShellArg(descriptor.sessionHome);
    return `exec env CODEX_HOME=${encodedHome} ${command}`;
  }
  return `exec ${command}`;
}

/**
 * A live pseudo-terminal session for one login command. The session allocates a
 * real pseudo-terminal, streams the raw terminal output, accepts delayed input,
 * and stops the child. The shape matches the `LoginPtySession` interface in
 * `@paperclipai/adapter-utils`, so the transport factory there accepts a session
 * opener that returns this session.
 */
export interface LoginPtySession {
  /** Registers the one output listener. The session streams each raw chunk in order. */
  onData(listener: (chunk: string) => void): void;
  /** Writes raw input bytes to the pseudo-terminal. */
  write(data: string): void;
  /** Resolves with the child exit code when the command ends. */
  wait(): Promise<{ exitCode: number | null }>;
  /** Stops the child process. Safe to call more than one time. */
  kill(): void;
  /** Releases the session resources. Safe to call more than one time. */
  close(): Promise<void>;
}

/** Opens a {@link LoginPtySession} for `descriptor`. The transport calls it one time. */
export type LoginPtySessionOpener = (
  descriptor: LoginPtyLaunchDescriptor,
) => Promise<LoginPtySession>;

/**
 * The subset of the Daytona SDK `PtyHandle` that the session uses. The SDK
 * `PtyHandle` satisfies this interface, so a caller passes the real handle with
 * no adapter.
 */
export interface DaytonaPtyHandle {
  /** Resolves when the PTY socket connection is ready for input and output. */
  waitForConnection(): Promise<void>;
  /** Sends raw input bytes to the pseudo-terminal. */
  sendInput(data: string | Uint8Array): Promise<void>;
  /** Resolves with the exit result when the pseudo-terminal process ends. */
  wait(): Promise<{ exitCode?: number; error?: string }>;
  /** Kills the pseudo-terminal process. */
  kill(): Promise<void>;
  /** Closes the PTY socket and releases the resources. */
  disconnect(): Promise<void>;
}

/**
 * The options the session passes to `createPty`. The session sets a fixed
 * terminal size and one output callback. It sets the working directory when the
 * caller provides one.
 */
export interface DaytonaPtyCreateOptions {
  id: string;
  cwd?: string;
  cols: number;
  rows: number;
  onData: (data: Uint8Array) => void | Promise<void>;
}

/**
 * The subset of the Daytona SDK `Process` that the session uses. The SDK
 * `Process` satisfies this interface, so a caller passes `sandbox.process`.
 */
export interface DaytonaPtyProcess {
  createPty(options: DaytonaPtyCreateOptions): Promise<DaytonaPtyHandle>;
}

/** The result of one command run on the sandbox. */
export interface DaytonaExecResult {
  exitCode?: number;
  result?: string;
}

/**
 * The subset of the Daytona SDK `Process` that the filesystem helper uses. The
 * SDK `Process` satisfies this interface through `executeCommand`, so a caller
 * passes `sandbox.process`.
 */
export interface DaytonaSandboxExec {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<DaytonaExecResult>;
}

/** One no-follow inspection of a filesystem path. */
export interface LoginHomeInspection {
  /** True when the path exists (as any type). */
  exists: boolean;
  /** True when the path itself is a symbolic link. */
  isSymlink: boolean;
  /** True when the path itself is a directory. */
  isDirectory: boolean;
  /** The octal permission string, for example `700`. Empty when the path is absent. */
  mode: string;
  /** The owner user id, or null when the path is absent. */
  ownerUid: number | null;
}

/**
 * The narrow filesystem surface the session home operations need. The production
 * surface runs commands on the sandbox; a unit test injects a fake. The inspection
 * and the creation walk each path component with a no-follow open, so a symlink at
 * any ancestor fails closed and a symlink at the target reports the link.
 */
export interface DaytonaLoginHomeFs {
  /** Resolves the user id of the login user that runs the pseudo-terminal. */
  loginUserId(): Promise<number>;
  /**
   * Inspects `path` without following a symlink at the target or at any ancestor.
   * It rejects (throws) when an ancestor is a symlink or a non-directory.
   */
  inspect(path: string): Promise<LoginHomeInspection>;
  /**
   * Creates `path` as a NEW directory with the octal `mode`. It creates the login
   * root ancestor if the root is absent. It fails when the target path exists or
   * when an ancestor is a symlink. It follows no composite pathname.
   */
  createDirectory(path: string, mode: string): Promise<void>;
}

/** The options for the Daytona login PTY session. */
export interface DaytonaLoginPtyOptions {
  /** The working directory for the login PTY. Defaults to the sandbox default. */
  cwd?: string;
}

// The terminal size for the login PTY. The login UI prints a short prompt, so a
// standard terminal size is enough. A fixed size keeps the output stable.
const LOGIN_PTY_COLS = 120;
const LOGIN_PTY_ROWS = 30;

/**
 * The input terminator that replaces the interactive shell with the login
 * command. The `exec` builtin replaces the shell process image with the command,
 * so the PTY runs the command directly. When the command ends, the PTY ends with
 * the command exit code, and the delayed input reaches the command, not a shell.
 * The terminal reads the carriage return as the Enter key.
 */
const PTY_COMMAND_TERMINATOR = "\r";

/** Normalizes an octal permission string to its numeric value for comparison. */
function octalMode(value: string): number {
  return Number.parseInt(value, 8);
}

/**
 * Revalidates the launch descriptor. It fails closed when the command key is
 * outside the closed set or the session home shape is wrong. A unit test that
 * bypasses the host boundary hits this check, so the provider never trusts an
 * unvalidated descriptor.
 */
function assertDescriptor(descriptor: LoginPtyLaunchDescriptor): void {
  if (!isLoginCommandKey(descriptor.loginCommandKey)) {
    throw new Error(LOGIN_PTY_DESCRIPTOR_REJECTED);
  }
  if (!SESSION_HOME_PATTERN.test(descriptor.sessionHome)) {
    throw new Error(LOGIN_PTY_DESCRIPTOR_REJECTED);
  }
}

/**
 * Creates and validates the exact session home directory. It rejects a
 * pre-existing target (including a symlink), creates the directory as a NEW
 * directory with mode 0700, then verifies the directory type, the no-symlink
 * state, the mode, and the login-user ownership. It uses no recursive delete.
 */
async function prepareSessionHome(fs: DaytonaLoginHomeFs, sessionHome: string): Promise<void> {
  const loginUid = await fs.loginUserId();

  // Reject a pre-existing target. A no-follow inspection reports a symlink, a
  // file, or a directory as present, so any pre-existing target fails here.
  const before = await fs.inspect(sessionHome);
  if (before.exists) {
    throw new Error(LOGIN_PTY_HOME_REJECTED);
  }

  // Create the exact directory as a NEW directory with mode 0700. The create
  // fails when the path exists, so the create never follows a symlink.
  await fs.createDirectory(sessionHome, LOGIN_HOME_MODE);

  // Verify the created directory. Reject a symlink, a non-directory, a wrong
  // owner, and a wrong mode. Do not delete on a rejection; the sandbox is
  // ephemeral and the provider uses no recursive delete.
  const after = await fs.inspect(sessionHome);
  if (
    !after.exists ||
    after.isSymlink ||
    !after.isDirectory ||
    after.ownerUid !== loginUid ||
    octalMode(after.mode) !== octalMode(LOGIN_HOME_MODE)
  ) {
    throw new Error(LOGIN_PTY_HOME_REJECTED);
  }
}

/**
 * Re-checks the directory with a no-symlink check. It rejects a symlink and a
 * non-directory, so a symlink swapped in after creation fails before the launch.
 */
async function assertHomeStillSafe(fs: DaytonaLoginHomeFs, sessionHome: string): Promise<void> {
  const now = await fs.inspect(sessionHome);
  if (!now.exists || now.isSymlink || !now.isDirectory) {
    throw new Error(LOGIN_PTY_HOME_REJECTED);
  }
}

/**
 * Opens a Daytona PTY session for `descriptor` and returns it as a
 * {@link LoginPtySession}. The function revalidates the descriptor and the home
 * shape, creates and validates the session home, opens a real pseudo-terminal,
 * re-checks the directory before the launch, composes the safe launch line, and
 * sends it. The session streams the raw terminal output, delivers delayed input,
 * and stops the child.
 *
 * The function decodes the terminal bytes as a UTF-8 stream, so a multibyte
 * character that splits across two output chunks stays whole. It buffers the
 * output until the transport registers the listener, so no early chunk is lost.
 */
export async function openDaytonaLoginPtySession(
  process: DaytonaPtyProcess,
  fs: DaytonaLoginHomeFs,
  descriptor: LoginPtyLaunchDescriptor,
  options?: DaytonaLoginPtyOptions,
): Promise<LoginPtySession> {
  assertDescriptor(descriptor);
  // Create and validate the session home before the terminal opens.
  await prepareSessionHome(fs, descriptor.sessionHome);
  // Re-check the directory with a no-symlink check before `createPty`.
  await assertHomeStillSafe(fs, descriptor.sessionHome);

  const decoder = new TextDecoder("utf-8");
  let listener: ((chunk: string) => void) | null = null;
  let buffered = "";

  const handle = await process.createPty({
    id: `paperclip-login-pty-${randomUUID()}`,
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    cols: LOGIN_PTY_COLS,
    rows: LOGIN_PTY_ROWS,
    onData: (data: Uint8Array): void => {
      // Decode the terminal bytes as a stream, so a split multibyte character
      // stays whole across two chunks. Forward the raw text; the parser owns the
      // ANSI and OSC 8 handling.
      const text = decoder.decode(data, { stream: true });
      if (text.length === 0) return;
      if (listener) listener(text);
      else buffered += text;
    },
  });

  await handle.waitForConnection();
  // Re-check the directory with a no-symlink check immediately before the launch
  // input, so a symlink swapped in after creation fails before `sendInput`.
  await assertHomeStillSafe(fs, descriptor.sessionHome);
  // Replace the interactive shell with the login command, so the pseudo-terminal
  // runs the command directly. The runner then writes the delayed browser code
  // to the command, not to a shell.
  await handle.sendInput(composeLaunchLine(descriptor) + PTY_COMMAND_TERMINATOR);

  // The tail of the write chain. The chunker awaits each chunk, so one write can
  // suspend between its chunks. The chain runs each write after the previous
  // write ends, so the chunks of two writes never interleave on the wire.
  let writeChain: Promise<void> = Promise.resolve();

  return {
    onData(next: (chunk: string) => void): void {
      listener = next;
      if (buffered.length > 0) {
        const pending = buffered;
        buffered = "";
        next(pending);
      }
    },
    write(data: string): void {
      // Send the input as byte-bounded chunks under the provider message cap. The
      // login input is short today, so the latent defect never fires, but the same
      // unbounded write goes through the one chunker. The chain runs this write
      // after the previous write ends, so two writes keep their order and never
      // interleave their chunks. A write error must not throw into the runner, so
      // the runner's fixed status stays the single result path.
      writeChain = writeChain.then(() =>
        sendPtyInputInChunks((chunk) => handle.sendInput(chunk), data),
      );
    },
    async wait(): Promise<{ exitCode: number | null }> {
      const result = await handle.wait();
      return { exitCode: typeof result.exitCode === "number" ? result.exitCode : null };
    },
    kill(): void {
      void handle.kill().catch(() => undefined);
    },
    async close(): Promise<void> {
      await handle.disconnect().catch(() => undefined);
    },
  };
}

/**
 * The inspection helper source. The provider reads it from its own script file and
 * runs it on the sandbox as `<login-profile-preamble> && node -e <script> <path>`.
 * The preamble sources the login profiles first, so `node` resolves on an image
 * that exposes node only through a login profile. The sandbox already runs node
 * for the Paperclip bridge, so the helper needs no extra runtime. The helper
 * source lives in `scripts/login-home-inspect.cjs`, so no large script stays as a
 * string literal in this module. The helper opens the filesystem root, then walks
 * each ancestor of the final path component with a no-follow, directory-only open,
 * and reads the final component with `lstat`.
 *
 * The helper prints one line and sets one exit code:
 * - a missing ancestor or a missing final component prints `ABSENT` and exits 0;
 * - an existing final component prints `<type>|<octal-mode>|<uid>` and exits 0,
 *   where `<type>` is `symlink`, `directory`, or `other`;
 * - a symlink or a non-directory at any ancestor prints nothing and exits 3, so
 *   the caller fails closed on an ancestor symlink.
 */
const LOGIN_HOME_INSPECT_SCRIPT = readFileSync(
  fileURLToPath(new URL("./scripts/login-home-inspect.cjs", import.meta.url)),
  "utf8",
);

/**
 * The creation helper source. The provider reads it from its own script file and
 * runs it on the sandbox as
 * `<login-profile-preamble> && node -e <script> <path> <octal-mode>`. The preamble
 * sources the login profiles first, so `node` resolves on an image that exposes
 * node only through a login profile. The helper source lives in
 * `scripts/login-home-create.cjs`. The helper opens the filesystem
 * root, then walks each ancestor above the login root with a no-follow,
 * directory-only open. It creates the login root (the second-to-last component) if
 * the root is absent, then opens the root with a no-follow open, so a symlink at
 * the root fails closed. It creates the final component as a NEW directory relative
 * to the root descriptor, so a pre-existing target fails and the create never
 * follows a symlink. It exits 0 on success and non-zero on every failure.
 *
 * The no-follow open of the root after the create closes the swap window: an
 * attacker that replaces the root with a symlink between the create and the open
 * fails the open.
 */
const LOGIN_HOME_CREATE_SCRIPT = readFileSync(
  fileURLToPath(new URL("./scripts/login-home-create.cjs", import.meta.url)),
  "utf8",
);

/**
 * The login-profile preamble for a node helper command. Daytona's
 * `executeCommand` runs the command in a non-login shell, so the shell does not
 * source `/etc/profile` on its own. The Daytona reference image puts `node` on
 * the PATH through `/etc/profile.d`, which only a login profile sources. The
 * login pseudo-terminal resolves the login command through the same profiles, so
 * the helper sources the login profiles first and a non-login shell then resolves
 * `node`. This keeps the helper runtime and the login PTY capability consistent:
 * an image that exposes `node` only through a login profile runs the helper. The
 * main exec path uses the same profile chain (see `buildLoginShellScript` in
 * `plugin.ts`). Each source line fails open (`|| true`), so a missing profile
 * does not fail the helper.
 */
const LOGIN_PROFILE_PREAMBLE = [
  "if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi",
  'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
  'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
  'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
].join(" && ");

/**
 * Composes a `node` helper command that runs after the login-profile preamble.
 * The preamble puts `node` on the PATH, then the `&&` chain runs `node -e` with
 * the already shell-encoded argument list. The `node` exit code becomes the
 * command exit code, and `2>/dev/null` suppresses only the node stderr. The
 * caller passes an argument string that is already shell-encoded.
 */
function composeNodeHelperCommand(encodedArgs: string): string {
  return `${LOGIN_PROFILE_PREAMBLE} && node -e ${encodedArgs} 2>/dev/null`;
}

/**
 * Creates a {@link DaytonaLoginHomeFs} bound to a Daytona `process`. It runs a
 * fixed node helper on the sandbox to inspect and create the session home. Each
 * helper opens the filesystem root, then walks each path component with a
 * no-follow, directory-only open, so a symlink at any ancestor fails closed. The
 * inspection reads the final component with `lstat`, so a symlink at the target
 * reports the link. The creation creates the login root if absent and the session
 * home as a NEW directory, both relative to an open trusted descriptor, so no
 * operation follows a composite pathname. The real filesystem operations land
 * against a live sandbox; a unit test injects a fake surface instead.
 */
export function createDaytonaLoginHomeFs(exec: DaytonaSandboxExec): DaytonaLoginHomeFs {
  return {
    async loginUserId(): Promise<number> {
      const out = await exec.executeCommand("id -u");
      const uid = Number.parseInt((out.result ?? "").trim(), 10);
      if (!Number.isInteger(uid)) {
        throw new Error(LOGIN_PTY_HOME_REJECTED);
      }
      return uid;
    },
    async inspect(path: string): Promise<LoginHomeInspection> {
      // Read the file type, the octal mode, and the owner uid with a descriptor
      // relative no-follow walk. A non-zero exit means a symlink or a non-directory
      // at an ancestor, so the read fails closed. An `ABSENT` line means the target
      // does not exist yet, which is the safe precondition for a create.
      const script = encodePosixShellArg(LOGIN_HOME_INSPECT_SCRIPT);
      const encodedPath = encodePosixShellArg(path);
      const out = await exec.executeCommand(composeNodeHelperCommand(`${script} ${encodedPath}`));
      if ((out.exitCode ?? 0) !== 0) {
        throw new Error(LOGIN_PTY_HOME_REJECTED);
      }
      const text = (out.result ?? "").trim();
      if (text.length === 0 || text === "ABSENT") {
        return { exists: false, isSymlink: false, isDirectory: false, mode: "", ownerUid: null };
      }
      const [fileType = "", mode = "", ownerText = ""] = text.split("|");
      const ownerUid = Number.parseInt(ownerText, 10);
      return {
        exists: true,
        isSymlink: fileType === "symlink",
        isDirectory: fileType === "directory",
        mode,
        ownerUid: Number.isInteger(ownerUid) ? ownerUid : null,
      };
    },
    async createDirectory(path: string, mode: string): Promise<void> {
      const script = encodePosixShellArg(LOGIN_HOME_CREATE_SCRIPT);
      const encodedPath = encodePosixShellArg(path);
      const encodedMode = encodePosixShellArg(mode);
      const out = await exec.executeCommand(
        composeNodeHelperCommand(`${script} ${encodedPath} ${encodedMode}`),
      );
      if ((out.exitCode ?? 0) !== 0) {
        throw new Error(LOGIN_PTY_HOME_REJECTED);
      }
    },
  };
}

/**
 * Creates a {@link LoginPtySessionOpener} bound to a Daytona `process` and a
 * {@link DaytonaLoginHomeFs}. The opener runs the login command on a real
 * pseudo-terminal, streams the terminal output, delivers the delayed browser code
 * plus the Enter byte, and stops the child for a terminal state.
 */
export function createDaytonaLoginPtySessionOpener(
  process: DaytonaPtyProcess,
  fs: DaytonaLoginHomeFs,
  options?: DaytonaLoginPtyOptions,
): LoginPtySessionOpener {
  return (descriptor: LoginPtyLaunchDescriptor) =>
    openDaytonaLoginPtySession(process, fs, descriptor, options);
}
