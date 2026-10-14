export function slackResourceLabelIsFallback(
  providerResourceId: string,
  label: string,
): boolean {
  const candidate = label.trim();
  return (
    candidate === providerResourceId ||
    candidate === `slack:${providerResourceId}`
  );
}
