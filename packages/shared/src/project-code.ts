export const PROJECT_CODE_MAX_LENGTH = 16;
export const PROJECT_CODE_PATTERN = /^[A-Z0-9]+$/;

export function normalizeProjectCode(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

export function isValidProjectCode(value: string): boolean {
  return value.length > 0
    && value.length <= PROJECT_CODE_MAX_LENGTH
    && PROJECT_CODE_PATTERN.test(value);
}
