export const COLLECT_SCRIPT = [
  'd=$1; m=$2; c=x',
  'if [ -f "$d/code" ]; then c=$(cat "$d/code"); fi',
  'o=0; e=0',
  'if [ -f "$d/out" ]; then o=$(wc -c <"$d/out"); fi',
  'if [ -f "$d/err" ]; then e=$(wc -c <"$d/err"); fi',
  'o=$((o+0)); e=$((e+0))',
  'if [ $((o+e)) -gt "$m" ]; then echo "K8 big $c $o $e"; exit 0; fi',
  'echo "K8 done $c $o $e"',
  'if [ "$o" -gt 0 ]; then base64 <"$d/out" | tr -d "\\n"; fi; echo',
  'if [ "$e" -gt 0 ]; then base64 <"$d/err" | tr -d "\\n"; fi; echo',
  'rm -rf "$d"',
].join("\n");

export const RUN_SCRIPT = [
  'd=$1; umask 077; mkdir -p "$d" || exit 125; echo $$ >"$d/pid"',
  'if [ -n "${PAPERCLIP_K8_SCRIPT+x}" ]; then printf %s "$PAPERCLIP_K8_SCRIPT" | base64 -d >"$d/script" || exit 125; fi',
  'if [ -n "${PAPERCLIP_K8_STDIN+x}" ]; then printf %s "$PAPERCLIP_K8_STDIN" | base64 -d >"$d/stdin" || exit 125; fi',
  'unset PAPERCLIP_K8_SCRIPT PAPERCLIP_K8_STDIN',
  '[ -f "$d/script" ] || exit 125',
  'i=/dev/null; if [ -f "$d/stdin" ]; then i=$d/stdin; fi',
  'if [ -z "$2" ] || cd "$2" 2>"$d/err"; then sh "$d/script" <"$i" >"$d/out" 2>>"$d/err"; c=$?; else : >"$d/out"; c=1; fi',
  'echo "$c" >"$d/code.tmp" && mv "$d/code.tmp" "$d/code"',
  'if [ "$3" = 1 ]; then exec sh -c "$5" k8collect "$d" "$4"; fi',
].join("\n");

export const STAGE_SCRIPT = 'umask 077; mkdir -p "$1" && printf %s "$PAPERCLIP_K8_CHUNK" | base64 -d >>"$1/$2"';
export const KILL_SCRIPT = [
  'n=0; while [ ! -f "$1/pid" ] && [ ! -f "$1/code" ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done',
  'p=$(cat "$1/pid" 2>/dev/null) || exit 0',
  'kill -s TERM -- -"$p" 2>/dev/null || kill -s TERM "$p" 2>/dev/null',
  '(sleep 5; kill -s KILL -- -"$p" 2>/dev/null || kill -s KILL "$p" 2>/dev/null) >/dev/null 2>&1 </dev/null &',
  'exit 0',
].join("\n");
export const READ_SCRIPT = 'tail -c +"$(($2 + 1))" "$1" | head -c "$3" | base64 | tr -d "\\n"';

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function buildLoginShellScript(input: { command: string; args: string[]; env?: Record<string, string> }): string {
  const env = input.env ?? {};
  for (const key of Object.keys(env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }
  const envArgs = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const commandParts = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  const execLine = envArgs.length > 0 ? `exec env ${envArgs.join(" ")} ${commandParts}` : `exec ${commandParts}`;
  return [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    execLine,
  ].join("\n");
}
