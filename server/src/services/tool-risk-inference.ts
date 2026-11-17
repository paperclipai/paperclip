/** Risk of a legacy plugin agent tool, inferred from its name. */
export function inferToolRisk(toolName: string): "read" | "write" | "destructive" {
  const lower = toolName.toLowerCase();
  if (
    /\b(delete|destroy|remove|drop|truncate|wipe|purge)\b|(^|[:._-])(delete|destroy|remove|drop|truncate|wipe|purge)([:._-]|$)/.test(
      lower,
    )
  ) {
    return "destructive";
  }
  if (
    /\b(create|update|write|edit|patch|post|send|publish|merge|commit|apply)\b|(^|[:._-])(create|update|write|edit|patch|post|send|publish|merge|commit|apply)([:._-]|$)/.test(
      lower,
    )
  ) {
    return "write";
  }
  return "read";
}
