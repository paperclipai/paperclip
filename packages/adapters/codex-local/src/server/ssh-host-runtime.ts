import { shellQuote } from "@paperclipai/adapter-utils/ssh";

export async function readCodexSshHostHome(input: {
  configuredHome?: string;
  run: (command: string) => Promise<{ stdout: string }>;
}): Promise<{ home: string; config: string; exists: boolean }> {
  const result = await input.run(`set -eu
native_codex_home=${input.configuredHome ? shellQuote(input.configuredHome) : '"${CODEX_HOME:-$HOME/.codex}"'}
case "$native_codex_home" in /*) ;; *) echo 'Remote CODEX_HOME must be absolute' >&2; exit 1 ;; esac
printf '%s' "$native_codex_home" | base64 | tr -d '\\r\\n'
printf '\\n'
if [ -e "$native_codex_home/config.toml" ]; then printf 'present\\n'; base64 < "$native_codex_home/config.toml"; else printf 'absent\\n'; fi`);
  const [encodedHome, status, ...encodedConfig] = result.stdout.split("\n");
  const home = Buffer.from(encodedHome ?? "", "base64").toString("utf8");
  if (!home.startsWith("/") || !["present", "absent"].includes(status ?? "")) throw new Error("Cannot read remote Codex configuration");
  return { home, config: Buffer.from(encodedConfig.join(""), "base64").toString("utf8"), exists: status === "present" };
}

export async function readCodexSshHostProfile(input: {
  home: string; profile: string; run: (command: string) => Promise<{ stdout: string }>;
}): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(input.profile)) throw new Error("Invalid remote Codex profile");
  const result = await input.run(`set -eu
profile_file=${shellQuote(`${input.home}/${input.profile}.config.toml`)}
test -f "$profile_file" && test ! -L "$profile_file"
base64 < "$profile_file"`);
  return Buffer.from(result.stdout, "base64").toString("utf8");
}

export function buildCodexSshHostRuntimeInstall(input: { home: string; assetDir: string; exists: boolean; profileFilename?: string }): string {
  if (input.profileFilename && !/^[A-Za-z0-9_-]+\.config\.toml$/.test(input.profileFilename)) throw new Error("Invalid Codex runtime profile");
  const script = `set -eu
umask 077
native_codex_home=$1
asset=$2
mkdir -p "$native_codex_home" "$native_codex_home/skills"
tmp=
created_skills=
cleanup_install() {
  install_status=$?
  trap - EXIT
  if [ "$install_status" -ne 0 ]; then
    for name in $created_skills; do
      if [ -L "$native_codex_home/skills/$name" ] && [ "$(readlink "$native_codex_home/skills/$name")" = "$asset/skills/$name" ]; then
        rm -f -- "$native_codex_home/skills/$name" || install_status=1
      fi
    done
  fi
  if [ -n "$tmp" ]; then rm -f "$tmp" "$tmp.skills" || install_status=1; fi
  exit "$install_status"
}
trap cleanup_install EXIT
trap 'exit 1' HUP INT TERM
tmp=$(mktemp "$native_codex_home/.paperclip-runtime-config.XXXXXX")
${input.exists ? 'cmp -s "$asset/.paperclip-native-config-before" "$native_codex_home/config.toml"' : '[ ! -e "$native_codex_home/config.toml" ]'} || { echo 'Codex configuration changed; retry this task' >&2; exit 1; }
${input.profileFilename ? `[ ! -e "$native_codex_home/"${shellQuote(input.profileFilename)} ] || { echo 'Codex runtime profile already exists' >&2; exit 1; }` : ""}
manifest="$native_codex_home/.paperclip-managed-skills"
for skill in "$asset/skills"/*; do
  [ -d "$skill" ] || continue
  name=\${skill##*/}
  case "$name" in ''|.|..|*[!A-Za-z0-9_.-]*) echo 'Invalid managed skill name' >&2; exit 1 ;; esac
  if [ -e "$native_codex_home/skills/$name" ] || [ -L "$native_codex_home/skills/$name" ]; then
    if ! [ -L "$native_codex_home/skills/$name" ] || ! grep -Fqx -- "$name" "$manifest" 2>/dev/null; then
      echo 'A remote skill conflicts with a managed skill; rename it before retrying' >&2; exit 1
    fi
  fi
done
if [ -f "$manifest" ]; then
  while IFS= read -r name; do
    case "$name" in ''|.|..|*[!A-Za-z0-9_.-]*) continue ;; esac
    if [ -L "$native_codex_home/skills/$name" ]; then rm -f -- "$native_codex_home/skills/$name"; fi
  done < "$manifest"
fi
: > "$tmp.skills"
for skill in "$asset/skills"/*; do
  [ -d "$skill" ] || continue
  name=\${skill##*/}
  created_skills="$created_skills $name"
  ln -s "$skill" "$native_codex_home/skills/$name"
  printf '%s\\n' "$name" >> "$tmp.skills"
done
cp "$asset/config.toml" "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$native_codex_home/config.toml"
mv -f "$tmp.skills" "$manifest"
${input.profileFilename ? `cp "$asset/"${shellQuote(input.profileFilename)} "$native_codex_home/"${shellQuote(input.profileFilename)}` : ""}`;
  return `sh -c ${shellQuote(script)} -- ${shellQuote(input.home)} ${shellQuote(input.assetDir)}`;
}
