export function repoAcceptanceScript(nonce: string, warm: boolean): string {
  if (!/^[a-f0-9-]{36}$/.test(nonce)) throw new Error("Acceptance nonce must be a UUID");
  const checkLayout = [
    'set -eu', 'test "$PWD" = "$HOME"',
    'for folder in task agent user project repos .codex .cache; do test -d "$HOME/$folder"; done',
    'count=0', 'for repo in "$HOME"/repos/*; do',
    '  test -d "$repo/.git" || continue', '  count=$((count + 1))', '  name=$(basename "$repo")',
    '  git -C "$repo" ls-remote --exit-code origin HEAD >/dev/null',
  ];
  const repoSteps = warm ? [
    `  test "$(git -C "$repo" show HEAD:.acceptance-owner)" = '${nonce}'`,
    '  test "$(git -C "$repo" rev-parse HEAD)" = "$(cat "$HOME/task/head-$name.txt")"',
    '  test "$(git -C "$repo" show :.acceptance-state)" = staged',
    '  test "$(cat "$repo/.acceptance-state")" = unstaged',
    '  test "$(cat "$repo/.acceptance-untracked")" = untracked',
    '  if git -C "$repo" ls-files --error-unmatch .acceptance-untracked >/dev/null 2>&1; then exit 1; fi',
  ] : [
    '  test ! -e "$repo/.acceptance-owner"',
    `  printf '%s' '${nonce}' > "$repo/.acceptance-owner"`,
    '  git -C "$repo" add -- .acceptance-owner',
    '  env GIT_AUTHOR_NAME=Acceptance GIT_AUTHOR_EMAIL=acceptance@example.invalid GIT_COMMITTER_NAME=Acceptance GIT_COMMITTER_EMAIL=acceptance@example.invalid git -C "$repo" commit -m acceptance',
    '  git -C "$repo" rev-parse HEAD > "$HOME/task/head-$name.txt"',
    '  printf staged > "$repo/.acceptance-state"', '  git -C "$repo" add -- .acceptance-state',
    '  printf unstaged > "$repo/.acceptance-state"', '  printf untracked > "$repo/.acceptance-untracked"',
  ];
  return [...checkLayout, ...repoSteps,
    '  if test -f "$repo/.acceptance-setup-count"; then test "$(wc -l < "$repo/.acceptance-setup-count")" -eq 1; fi',
    'done', 'test "$count" -ge 2',
    ...(warm ? [
      `test "$(cat "$HOME/task/acceptance.txt")" = '${nonce}'`,
      `test "$(cat "$HOME/.cache/warm-${nonce}")" = '${nonce}'`,
      `printf '%s' '${nonce}' > "$HOME/task/warm.txt"`,
    ] : [
      `printf '%s' '${nonce}' > "$HOME/task/acceptance.txt"`,
      `printf '%s' '${nonce}' > "$HOME/agent/acceptance-${nonce}.txt"`,
      `printf '%s' '${nonce}' > "$HOME/.cache/warm-${nonce}"`,
    ]),
    'for scope in task agent user project; do',
    ...(warm ? [
      `test "$(cat "$HOME/$scope/roundtrip-${nonce}/message.txt")" = '${nonce}'`,
      `test -f "$HOME/$scope/roundtrip-${nonce}/empty.sh"`,
      `test ! -s "$HOME/$scope/roundtrip-${nonce}/empty.sh"`,
      `test -x "$HOME/$scope/roundtrip-${nonce}/empty.sh"`,
    ] : [
      `mkdir -p "$HOME/$scope/roundtrip-${nonce}"`,
      `printf '%s' '${nonce}' > "$HOME/$scope/roundtrip-${nonce}/message.txt"`,
      `: > "$HOME/$scope/roundtrip-${nonce}/empty.sh"`,
      `chmod +x "$HOME/$scope/roundtrip-${nonce}/empty.sh"`,
    ]),
    'done', 'printf "ACCEPTANCE_SCRIPT_PASSED\\n"',
  ].join("\n");
}

export function repoAcceptancePrompt(nonce: string, warm: boolean): string {
  return [
    "Execute this exact acceptance shell script from your initial working directory in one tool call. Use real filesystem tools; do not simulate its result. Do not change PATH, bypass the managed git launcher, extract credentials, repair partial state, or retry after any failed command. If anything fails, immediately stop and mark the task blocked as instructed.",
    warm ? "This must reuse the same warm sandbox. Do not repair, recreate, or reset missing state." : "This creates disposable local commits and staged, unstaged, and untracked test files. Do not push.",
    'If any assertion fails, stop and PATCH the task with status "blocked" and unblockDescriptor {"owner":{"agentId":"<your PAPERCLIP_AGENT_ID>"},"action":"Investigate the failed acceptance assertion"}, replacing the placeholder with your agent ID and including the actual error in your comment. Otherwise mark the Paperclip task done after the script succeeds.',
    "```sh", repoAcceptanceScript(nonce, warm), "```",
  ].join("\n");
}
