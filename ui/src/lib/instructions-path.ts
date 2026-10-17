export function normalizeInstructionsFilePath(value: string): string {
  return value
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}
