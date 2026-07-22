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
