import { readNonEmptyTrimmedString as asNonEmptyString } from "@paperclipai/shared";

export function hasLegacyWorkingDirectory(value: unknown): boolean {
  return asNonEmptyString(value) !== null;
}

export function shouldShowLegacyWorkingDirectoryField(input: {
  isCreate: boolean;
  adapterConfig: Record<string, unknown> | null | undefined;
}): boolean {
  if (input.isCreate) return false;
  return hasLegacyWorkingDirectory(input.adapterConfig?.cwd);
}
