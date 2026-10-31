/** Preserve the selected Grok search policy across startup and recovery. */
export function resolveGrokDisableWebSearch(agent: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (agent !== "grok" || typeof value !== "boolean") throw new Error("Grok web search policy requires a Grok boolean setting");
  return value;
}

export function admittedGrokWebSearchPolicy(agent: string, expected: unknown, descriptor: Record<string, unknown>, identity: Record<string, unknown>): void {
  const selected = resolveGrokDisableWebSearch(agent, expected);
  if (descriptor.grokDisableWebSearch !== selected || identity.grokDisableWebSearch !== selected) {
    throw new Error("Grok web search policy differs from the admitted configuration");
  }
}
