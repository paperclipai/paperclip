import path from "node:path";

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** Own only links into the private store; never replace a user's skill. */
export function buildAgyRemoteSkillsCommand(skillsHome: string, source: string, names: string[]): string {
  for (const name of names) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`Invalid AGY skill name: ${name}`);
  }
  const cleanSkillsHome = skillsHome.replace(/\/+$/, "");
  const cleanSource = source.replace(/\/+$/, "");
  const managed = path.posix.join(cleanSkillsHome, "..", ".paperclip-agy-skills");
  return [
    "set -eu",
    `skills=${shellQuote(cleanSkillsHome)}`,
    `managed=${shellQuote(managed)}`,
    `source=${shellQuote(cleanSource)}`,
    // Refuse redirected roots before removing or copying anything.
    'if [ -L "$skills" ] || [ -L "$managed" ]; then',
    '  echo "Refusing symlinked skills root" >&2',
    '  exit 1',
    'fi',
    'mkdir -p "$skills" "$managed"',
    'for target in "$skills"/*; do',
    '  [ -L "$target" ] || continue',
    '  name=${target##*/}',
    '  [ "$(readlink "$target")" = "$managed/$name" ] || continue',
    '  rm -- "$target"',
    'done',
    ...names.flatMap((name) => [
      `name=${shellQuote(name)}`,
      // An external directory, file or dangling link wins on collisions.
      'if [ ! -e "$skills/$name" ] && [ ! -L "$skills/$name" ]; then',
      '  rm -rf -- "$managed/$name"',
      '  cp -a -- "$source/$name" "$managed/$name"',
      '  ln -s -- "$managed/$name" "$skills/$name"',
      'fi',
    ]),
  ].join("\n");
}

