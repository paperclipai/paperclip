export function parseOnboardingGoalInput(raw: string): {
  title: string;
  description: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { title: "", description: null };
  }

  const [firstLine, ...restLines] = trimmed.split(/\r?\n/);
  const title = firstLine.trim();
  const description = restLines.join("\n").trim();

  return {
    title,
    description: description.length > 0 ? description : null,
  };
}

/**
 * Inverse of {@link parseOnboardingGoalInput}: render a stored goal back into
 * the single textarea the mission step edits.
 *
 * Used when the wizard is entered on a company that already has a mission, so
 * the mission can be shown and re-saved instead of retyped from scratch.
 */
export function formatOnboardingGoalInput(
  title: string,
  description?: string | null,
): string {
  const trimmedTitle = title.trim();
  const trimmedDescription = description?.trim() ?? "";

  if (!trimmedTitle) return trimmedDescription;
  if (!trimmedDescription) return trimmedTitle;

  return `${trimmedTitle}\n\n${trimmedDescription}`;
}
