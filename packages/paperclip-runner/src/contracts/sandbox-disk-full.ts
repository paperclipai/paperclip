/**
 * The `code` a runner launch failure carries when the sandbox disk is full and
 * nothing Paperclip owns is left to free. Runner process recovery stops at once
 * on it: the same launch fails the same way for the rest of the grace.
 */
export const SANDBOX_DISK_FULL_FAILURE_CODE = "sandbox_disk_full";

export function isSandboxDiskFullFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === SANDBOX_DISK_FULL_FAILURE_CODE;
}
