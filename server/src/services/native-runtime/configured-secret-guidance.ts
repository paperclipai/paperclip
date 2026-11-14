/**
 * Task guidance for configured secrets. Names only: the agent already receives
 * these variables in its command environment. The runtime also keeps their
 * values out of captured output, so this guidance is a first line of defense,
 * not the guarantee.
 */
export function configuredSecretGuidance(names: readonly string[]): string | null {
  const unique = [...new Set(names)].filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).sort();
  if (unique.length === 0) return null;
  const example = unique[0]!;
  return [
    "## Configured secrets",
    `Commands receive these secrets as environment variables: ${unique.map(name => `\`${name}\``).join(", ")}.`,
    `To check that one is set, use \`[ -n "$${example}" ]\`. Never print, echo, log, or write a secret value to a file; pass it only to the program that needs it.`,
  ].join("\n");
}
