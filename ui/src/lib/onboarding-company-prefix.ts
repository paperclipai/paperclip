export function deriveOnboardingIssuePrefix(companyName: string): string {
  return companyName.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
}

export function sanitizeOnboardingIssuePrefix(value: string): string {
  return value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
}

export function validateOnboardingIssuePrefix(
  issuePrefix: string,
  companies: ReadonlyArray<{ issuePrefix: string }>,
): string | null {
  const normalized = issuePrefix.trim().toUpperCase();
  if (!/^[A-Z]{2,4}$/.test(normalized)) {
    return "Issue prefix must be 2-4 uppercase letters.";
  }

  if (
    companies.some(
      (company) => company.issuePrefix.toUpperCase() === normalized,
    )
  ) {
    return `Issue prefix ${normalized} is already in use.`;
  }

  return null;
}
