export function repoAcceptanceScript(nonce: string, warm: boolean): string {
  if (!/^[a-f0-9-]{36}$/.test(nonce)) throw new Error("Acceptance nonce must be a UUID");
  const checkLayout = [
    'set -eu', 'test "$PWD" = "$HOME"',
    'for folder in task agent user project repos .codex .cache; do test -d "$HOME/$folder"; done',
    'count=0', 'for repo in "$HOME"/repos/*; do',
    '  test -d "$repo/.git" || continue', '  count=$((count + 1))', '  name=$(basename "$repo")',
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
    '  git -C "$repo" -c user.name=Acceptance -c user.email=acceptance@example.invalid commit -m acceptance',
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
    ]), 'printf "ACCEPTANCE_SCRIPT_PASSED\\n"',
  ].join("\n");
}

export function repoAcceptancePrompt(nonce: string, warm: boolean): string {
  return [
    "Execute this exact acceptance shell script from your initial working directory in one tool call. Use real filesystem tools; do not simulate its result.",
    warm ? "This must reuse the same warm sandbox. Do not repair, recreate, or reset missing state." : "This creates disposable local commits and staged, unstaged, and untracked test files. Do not push.",
    'If any assertion fails, stop and PATCH the task with status "blocked" and unblockDescriptor {"owner":{"agentId":"<your PAPERCLIP_AGENT_ID>"},"action":"Investigate the failed acceptance assertion"}, replacing the placeholder with your agent ID and including the actual error in your comment. Otherwise mark the Paperclip task done after the script succeeds.',
    "```sh", repoAcceptanceScript(nonce, warm), "```",
  ].join("\n");
}
