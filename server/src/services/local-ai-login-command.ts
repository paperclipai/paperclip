const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The terminal command a user runs on the server host to sign in to a provider.
 * The server reads the result as its own account, but the person running the
 * command is often root, so the folder is handed back to the server account. */
export function localAiLoginCommand(
  provider: string,
  directory: string,
  owner: { uid?: number; gid?: number } = { uid: process.getuid?.(), gid: process.getgid?.() },
) {
  const withOwner = (variable: string) => owner.uid === undefined || owner.gid === undefined
    ? "" : ` && chown -R ${owner.uid}:${owner.gid} "$${variable}"`;
  const dir = shellQuote(directory);
  if (provider === "openai")
    return `(export CODEX_HOME=${dir} && mkdir -p "$CODEX_HOME" && codex -c 'cli_auth_credentials_store="file"' login --device-auth${withOwner("CODEX_HOME")})`;
  if (provider === "anthropic")
    return `(export CLAUDE_CONFIG_DIR=${dir} && mkdir -p "$CLAUDE_CONFIG_DIR" && claude auth login${withOwner("CLAUDE_CONFIG_DIR")})`;
  return `(export GROK_HOME=${dir} && mkdir -p "$GROK_HOME" && grok login --device-auth${withOwner("GROK_HOME")})`;
}
