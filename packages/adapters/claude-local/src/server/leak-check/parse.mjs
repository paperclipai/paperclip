// Pure-JS argv parser for the gh/git leak-check shim. Plain ESM so the same
// file can be imported both by the spawned shim entry script and by the
// adapter's TypeScript unit tests.
//
// Parser output: a list of "scan targets" extracted from the argv of a single
// gh/git invocation. Each target is either:
//   - inline string (e.g. --body "hello")
//   - file (e.g. --body-file body.md, -F message.txt, -f body=@file.md)
//   - stdin (e.g. --body-file -, git commit -F -, git commit --amend implicit)
//
// The shim then pipes the resolved body through leak-check.sh; if ANY target
// hits, the invocation is refused. A shim request with no scan targets is
// passed through untouched.

/** @typedef {{ kind: "string", source: string, value: string }} StringTarget */
/** @typedef {{ kind: "file", source: string, path: string }} FileTarget */
/** @typedef {{ kind: "stdin", source: string }} StdinTarget */
/** @typedef {StringTarget | FileTarget | StdinTarget} ScanTarget */

/**
 * @typedef {Object} ParsedShimRequest
 * @property {"gh"|"git"} command
 * @property {string|null} subCommand   - e.g. "pr", "api", "commit"
 * @property {string|null} verb         - e.g. "create" (when applicable)
 * @property {ScanTarget[]} scanTargets
 * @property {boolean} hasAllowOverride - true if --allow-leak-OK was passed
 * @property {boolean} unsupported      - true if we don't know how to scan this shape; pass through
 */

const GH_BODY_FLAGS_INLINE = new Set([
  "-b", "--body", "-t", "--title",
]);
const GH_BODY_FLAGS_FILE = new Set([
  "-F", "--body-file",
]);
// git: only certain subcommands carry bodies that we scan.
const GIT_BODY_SUBCOMMANDS = new Set(["commit", "tag", "notes"]);

/**
 * @param {readonly string[]} argv
 * @returns {ParsedShimRequest}
 */
export function parseGhArgs(argv) {
  /** @type {ParsedShimRequest} */
  const result = {
    command: "gh",
    subCommand: null,
    verb: null,
    scanTargets: [],
    hasAllowOverride: false,
    unsupported: false,
  };

  if (argv.length === 0) {
    result.unsupported = true;
    return result;
  }

  // Strip leak-check override flag from the visible argv so we don't pass it
  // to real gh. (Tracks position-independent.)
  const args = [];
  for (const arg of argv) {
    if (arg === "--allow-leak-OK") {
      result.hasAllowOverride = true;
    } else {
      args.push(arg);
    }
  }

  const sub = args[0];
  result.subCommand = sub ?? null;

  if (sub === "pr" || sub === "issue") {
    result.verb = args[1] ?? null;
    const scannedVerbs = new Set(["create", "edit", "comment", "review"]);
    if (!result.verb || !scannedVerbs.has(result.verb)) {
      result.unsupported = true;
      return result;
    }
    collectInlineAndFileBodyFlags(args, result.scanTargets);
    return result;
  }

  if (sub === "api") {
    collectGhApiFieldTargets(args, result.scanTargets);
    return result;
  }

  if (sub === "release") {
    result.verb = args[1] ?? null;
    const scannedVerbs = new Set(["create", "edit"]);
    if (!result.verb || !scannedVerbs.has(result.verb)) {
      result.unsupported = true;
      return result;
    }
    // gh release uses --notes / --notes-file (and --notes-from-tag — skip).
    collectGhReleaseNotesFlags(args, result.scanTargets);
    return result;
  }

  result.unsupported = true;
  return result;
}

/**
 * @param {readonly string[]} argv
 * @returns {ParsedShimRequest}
 */
export function parseGitArgs(argv) {
  /** @type {ParsedShimRequest} */
  const result = {
    command: "git",
    subCommand: null,
    verb: null,
    scanTargets: [],
    hasAllowOverride: false,
    unsupported: false,
  };
  if (argv.length === 0) {
    result.unsupported = true;
    return result;
  }

  // Skip git's own pre-subcommand flags (e.g. `git -C dir commit ...`,
  // `git --git-dir=.git commit ...`). These can take a value or be attached.
  const TAKES_VALUE_GIT_OPTS = new Set([
    "-C", "-c", "--git-dir", "--work-tree", "--namespace",
    "--super-prefix", "--exec-path", "--config-env",
  ]);
  const args = [];
  for (const arg of argv) {
    if (arg === "--allow-leak-OK") {
      result.hasAllowOverride = true;
    } else {
      args.push(arg);
    }
  }

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith("-")) break;
    if (TAKES_VALUE_GIT_OPTS.has(arg)) {
      i += 2;
      continue;
    }
    // Attached form like --git-dir=.git or -Cfoo
    if (arg.startsWith("--") && arg.includes("=")) {
      i += 1;
      continue;
    }
    if (arg === "-C" || arg === "-c") {
      // already handled above; defensive
      i += 2;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1 && /^-[A-Za-z]$/.test(arg.slice(0, 2))) {
      i += 1;
      continue;
    }
    i += 1;
  }

  const sub = args[i];
  result.subCommand = sub ?? null;
  if (!sub || !GIT_BODY_SUBCOMMANDS.has(sub)) {
    result.unsupported = true;
    return result;
  }
  const subArgs = args.slice(i + 1);

  if (sub === "commit") {
    collectGitCommitTargets(subArgs, result.scanTargets);
    return result;
  }
  if (sub === "tag") {
    collectGitTagTargets(subArgs, result.scanTargets);
    return result;
  }
  if (sub === "notes") {
    collectGitNotesTargets(subArgs, result.scanTargets);
    return result;
  }
  result.unsupported = true;
  return result;
}

function pushInlineString(targets, source, value) {
  if (typeof value === "string" && value.length > 0) {
    targets.push({ kind: "string", source, value });
  }
}

function pushFileTarget(targets, source, fileArg) {
  if (typeof fileArg !== "string" || fileArg.length === 0) return;
  if (fileArg === "-") {
    targets.push({ kind: "stdin", source });
    return;
  }
  targets.push({ kind: "file", source, path: fileArg });
}

/**
 * Walk an argv list and pick up `--body`/`--title`/`--body-file`-style flags.
 * Handles attached form (`--body=hello`).
 */
function collectInlineAndFileBodyFlags(args, targets) {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (GH_BODY_FLAGS_INLINE.has(arg)) {
      pushInlineString(targets, `gh ${arg}`, args[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (GH_BODY_FLAGS_FILE.has(arg)) {
      pushFileTarget(targets, `gh ${arg}`, args[i + 1] ?? "");
      i += 2;
      continue;
    }
    // Attached form: --body=foo / --title=foo / --body-file=foo
    if (arg.startsWith("--body=")) {
      pushInlineString(targets, "gh --body=", arg.slice("--body=".length));
      i += 1;
      continue;
    }
    if (arg.startsWith("--title=")) {
      pushInlineString(targets, "gh --title=", arg.slice("--title=".length));
      i += 1;
      continue;
    }
    if (arg.startsWith("--body-file=")) {
      pushFileTarget(targets, "gh --body-file=", arg.slice("--body-file=".length));
      i += 1;
      continue;
    }
    i += 1;
  }
}

function collectGhReleaseNotesFlags(args, targets) {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--notes" || arg === "-n") {
      pushInlineString(targets, `gh ${arg}`, args[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (arg === "--notes-file" || arg === "-F") {
      pushFileTarget(targets, `gh ${arg}`, args[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (arg.startsWith("--notes=")) {
      pushInlineString(targets, "gh --notes=", arg.slice("--notes=".length));
      i += 1;
      continue;
    }
    if (arg.startsWith("--notes-file=")) {
      pushFileTarget(targets, "gh --notes-file=", arg.slice("--notes-file=".length));
      i += 1;
      continue;
    }
    if (arg === "--title" || arg === "-t") {
      pushInlineString(targets, `gh ${arg}`, args[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (arg.startsWith("--title=")) {
      pushInlineString(targets, "gh --title=", arg.slice("--title=".length));
      i += 1;
      continue;
    }
    i += 1;
  }
}

/**
 * `gh api` uses `-f body=value`, `-F body=value`, `--field body=value`,
 * `--raw-field body=value`. Values prefixed with `@` reference a file
 * (`-f body=@body.md`), and `-` reads stdin (`-f body=@-`).
 *
 * Only scan when the target endpoint is plausibly a write op that publishes
 * to a customer repo. For simplicity we scan any `body` field on any `api`
 * call — false positives only manifest as a leak-check that doesn't trigger
 * (since paperclip patterns are unique).
 */
function collectGhApiFieldTargets(args, targets) {
  const FIELD_FLAGS_FILE = new Set(["-F", "--field"]);
  const FIELD_FLAGS_STRING = new Set(["-f", "--raw-field"]);
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    const isFile = FIELD_FLAGS_FILE.has(arg);
    const isString = FIELD_FLAGS_STRING.has(arg);
    if (isFile || isString) {
      const next = args[i + 1] ?? "";
      i += 2;
      const eq = next.indexOf("=");
      if (eq <= 0) continue;
      const name = next.slice(0, eq);
      const value = next.slice(eq + 1);
      if (name !== "body" && name !== "title" && name !== "message") continue;
      addFieldTarget(targets, `gh api ${arg} ${name}=`, value, isFile);
      continue;
    }
    // Attached: -fbody=... is technically valid for short flags but rarely used; skip.
    i += 1;
  }
}

function addFieldTarget(targets, source, value, fieldFlagIsFileType) {
  if (typeof value !== "string") return;
  if (value.startsWith("@")) {
    const fileArg = value.slice(1);
    pushFileTarget(targets, source + "@", fileArg);
    return;
  }
  // -F (file) without @-prefix still publishes the raw value, so scan it as
  // a string. -f (raw-field) is unambiguously a string.
  void fieldFlagIsFileType;
  pushInlineString(targets, source, value);
}

function collectGitCommitTargets(args, targets) {
  let i = 0;
  let sawAmend = false;
  let sawMessageFlag = false;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-m" || arg === "--message") {
      pushInlineString(targets, `git commit ${arg}`, args[i + 1] ?? "");
      sawMessageFlag = true;
      i += 2;
      continue;
    }
    if (arg === "-F" || arg === "--file") {
      pushFileTarget(targets, `git commit ${arg}`, args[i + 1] ?? "");
      sawMessageFlag = true;
      i += 2;
      continue;
    }
    if (arg.startsWith("--message=")) {
      pushInlineString(targets, "git commit --message=", arg.slice("--message=".length));
      sawMessageFlag = true;
      i += 1;
      continue;
    }
    if (arg.startsWith("--file=")) {
      pushFileTarget(targets, "git commit --file=", arg.slice("--file=".length));
      sawMessageFlag = true;
      i += 1;
      continue;
    }
    if (arg === "--amend") {
      sawAmend = true;
      i += 1;
      continue;
    }
    if (arg === "--no-edit") {
      // amend with --no-edit reuses the existing commit message; we can't
      // scan reliably without checking the repo, so let it through and rely
      // on the previous commit having been scanned at its original write.
      i += 1;
      continue;
    }
    if (arg.startsWith("--message=") || arg.startsWith("--file=")) {
      i += 1;
      continue;
    }
    i += 1;
  }
  // git commit / git commit --amend with no -m or -F opens an editor — those
  // surface to the agent's terminal, not a one-shot publish, so we don't
  // scan. (Headless agents wouldn't reach the editor.)
  void sawAmend;
  void sawMessageFlag;
}

function collectGitTagTargets(args, targets) {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-m" || arg === "--message") {
      pushInlineString(targets, `git tag ${arg}`, args[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (arg === "-F" || arg === "--file") {
      pushFileTarget(targets, `git tag ${arg}`, args[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (arg.startsWith("--message=")) {
      pushInlineString(targets, "git tag --message=", arg.slice("--message=".length));
      i += 1;
      continue;
    }
    if (arg.startsWith("--file=")) {
      pushFileTarget(targets, "git tag --file=", arg.slice("--file=".length));
      i += 1;
      continue;
    }
    i += 1;
  }
}

function collectGitNotesTargets(args, targets) {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-m" || arg === "--message") {
      pushInlineString(targets, `git notes ${arg}`, args[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (arg === "-F" || arg === "--file") {
      pushFileTarget(targets, `git notes ${arg}`, args[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (arg.startsWith("--message=")) {
      pushInlineString(targets, "git notes --message=", arg.slice("--message=".length));
      i += 1;
      continue;
    }
    if (arg.startsWith("--file=")) {
      pushFileTarget(targets, "git notes --file=", arg.slice("--file=".length));
      i += 1;
      continue;
    }
    i += 1;
  }
}
