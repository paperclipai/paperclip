export class UsageError extends Error {}

export const COMMANDS = {
  new: {
    strings: ["slug", "title", "surfaces", "directions", "names", "group", "capabilities", "company", "landing", "ports", "root"],
    booleans: ["force-count", "dry-run", "json", "skip-verify", "no-build", "keep-on-failure"],
  },
  check: { strings: ["slug", "root"], booleans: ["strict", "run", "json", "skip-verify"] },
  "add-direction": { strings: ["slug", "name", "root"], booleans: ["force-count", "json", "skip-verify"] },
  list: { strings: ["root"], booleans: ["json"] },
};

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") return { command: "help", flags: {} };
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`unknown subcommand "${command}"; expected one of ${Object.keys(COMMANDS).join(", ")}`);
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) throw new UsageError(`unexpected argument "${token}"`);
    const [rawKey, inline] = token.slice(2).split(/=(.*)/s);
    if (spec.booleans.includes(rawKey)) {
      if (inline !== undefined && inline !== "true" && inline !== "false") throw new UsageError(`--${rawKey} takes no value`);
      flags[rawKey] = inline !== "false";
      continue;
    }
    if (!spec.strings.includes(rawKey)) throw new UsageError(`unknown flag --${rawKey} for ${command}`);
    const value = inline !== undefined ? inline : rest[(i += 1)];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${rawKey} needs a value`);
    flags[rawKey] = value;
  }
  return { command, flags };
}

export function helpText() {
  return `Usage:
  scaffold.mjs new --slug <slug> --title <Title> --surfaces id:Label:width@nav,... --directions 2|3
               [--names a,b[,c]] [--group Components|Pages|Layouts|Patterns] [--capabilities a/k,...]
               [--company name:PREFIX] [--landing auto|all|today|<id>] [--ports dev,preview]
               [--force-count] [--dry-run] [--json] [--skip-verify] [--no-build] [--keep-on-failure] [--root <dir>]
  scaffold.mjs check --slug <slug> [--strict] [--run] [--json] [--skip-verify] [--root <dir>]
  scaffold.mjs add-direction --slug <slug> --name <Name> [--force-count] [--json] [--skip-verify] [--root <dir>]
  scaffold.mjs list [--json] [--root <dir>]

Exit 0 on success, 1 on any failure (the failing command's output is printed).`;
}
