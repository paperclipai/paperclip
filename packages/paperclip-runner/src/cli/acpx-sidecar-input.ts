import { enqueueSerialInput } from "./serial-input-queue.js";

const ACPX_BOOTSTRAP_COMMANDS = new Set(["initialize", "session.open"]);

export function enqueueAcpxSidecarInput(
  pending: Promise<void>,
  operation: () => Promise<void>,
  onError: (error: unknown) => void | Promise<void>,
): Promise<void> {
  return enqueueSerialInput(pending, operation, onError);
}

export function recordAcpxBootstrapFailure(
  current: Error | null,
  command: string,
  error: Error,
): Error | null {
  return current ?? (ACPX_BOOTSTRAP_COMMANDS.has(command) ? error : null);
}

export function acpxBootstrapBlockedError(
  failure: Error | null,
  command: string,
): Error | null {
  return failure
    ? new Error(
        `ACPX provider bootstrap failed before ${command}: ${failure.message}`,
      )
    : null;
}
