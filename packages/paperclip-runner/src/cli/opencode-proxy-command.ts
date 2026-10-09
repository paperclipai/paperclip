import { QUALIFIED_OPENCODE_VERSION } from "../drivers/opencode/opencode-server-driver.js";
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

export const TRUSTED_OPENCODE_EXECUTABLE_ARG =
  "--paperclip-trusted-opencode-executable";

export function withoutAmbientOpenCodeCommand(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized.PAPERCLIP_OPENCODE_COMMAND;
  return sanitized;
}

/**
 * Consumes only the binding injected by runnerd after its startup profile has
 * authenticated the executable. An inherited descriptor keeps the verified
 * file identity bound through the nested Node spawn on supported Unix hosts;
 * unsupported platforms fail closed in runnerd before this proxy starts.
 */
export function trustedOpenCodeLaunchBinding(
  args: readonly string[],
): {
  command: string;
  commandFd?: number;
  commandLifecycle?: {
    beforeSpawn(): void;
    afterSpawn(): void;
  };
} {
  const command = args.length === 2 && args[0] === TRUSTED_OPENCODE_EXECUTABLE_ARG
    ? args[1]!
    : "";
  const matched = process.platform === "linux"
    ? command.match(/^\/proc\/self\/fd\/(\d+)$/)
    : null;
  const commandFd = Number(matched?.[1]);
  if (matched && Number.isInteger(commandFd) && commandFd >= 3 && commandFd <= 255) {
    return { command, commandFd };
  }
  const validateMacSnapshot = (expected?: { dev: number; ino: number }) => {
    let snapshotIsValid = false;
    let metadata: ReturnType<typeof lstatSync> | undefined;
    try {
      metadata = lstatSync(command);
      const directoryMetadata = lstatSync(dirname(command));
      const currentUid = process.getuid?.();
      snapshotIsValid =
        metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        metadata.nlink === 1 &&
        (metadata.mode & 0o777) === 0o500 &&
        directoryMetadata.isDirectory() &&
        !directoryMetadata.isSymbolicLink() &&
        (directoryMetadata.mode & 0o777) === 0o700 &&
        currentUid !== undefined &&
        metadata.uid === currentUid &&
        directoryMetadata.uid === currentUid &&
        (expected === undefined ||
          (metadata.dev === expected.dev && metadata.ino === expected.ino));
    } catch {
      snapshotIsValid = false;
    }
    if (!snapshotIsValid) {
      throw new Error(
        `OpenCode ${QUALIFIED_OPENCODE_VERSION} runner-owned executable binding is unavailable; refusing ambient PATH or PAPERCLIP_OPENCODE_COMMAND fallback`,
      );
    }
    return metadata!;
  };
  if (
    process.platform === "darwin" &&
    isAbsolute(command) &&
    basename(command) === "launch" &&
    /^\.paperclip-verified-executable-[0-9a-f]{32}$/.test(
      basename(dirname(command)),
    )
  ) {
    const initialMetadata = validateMacSnapshot();
    let sourceFd: number;
    try {
      sourceFd = openSync(command, "r");
    } catch {
      throw new Error(
        `OpenCode ${QUALIFIED_OPENCODE_VERSION} runner-owned executable binding is unavailable; refusing ambient PATH or PAPERCLIP_OPENCODE_COMMAND fallback`,
      );
    }
    const sourceMetadata = fstatSync(sourceFd);
    if (
      sourceMetadata.dev !== initialMetadata.dev ||
      sourceMetadata.ino !== initialMetadata.ino
    ) {
      closeSync(sourceFd);
      throw new Error(
        `OpenCode ${QUALIFIED_OPENCODE_VERSION} runner-owned executable binding is unavailable; refusing ambient PATH or PAPERCLIP_OPENCODE_COMMAND fallback`,
      );
    }
    try {
      unlinkSync(command);
      rmdirSync(dirname(command));
    } catch (error) {
      closeSync(sourceFd);
      throw error;
    }
    let materialized = false;
    let materializedIdentity: { dev: number; ino: number } | undefined;
    const materializeForSpawn = () => {
      if (materialized) {
        validateMacSnapshot(materializedIdentity);
        return;
      }
      let destinationFd: number | undefined;
      try {
        mkdirSync(dirname(command), { mode: 0o700 });
        chmodSync(dirname(command), 0o700);
        destinationFd = openSync(command, "wx", 0o700);
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let sourceOffset = 0;
        while (sourceOffset < sourceMetadata.size) {
          const count = readSync(
            sourceFd,
            buffer,
            0,
            Math.min(buffer.length, sourceMetadata.size - sourceOffset),
            sourceOffset,
          );
          if (count === 0) throw new Error("verified OpenCode snapshot ended early");
          let written = 0;
          while (written < count) {
            const writeCount = writeSync(
              destinationFd,
              buffer,
              written,
              count - written,
            );
            if (writeCount === 0) {
              throw new Error("verified OpenCode snapshot copy made no progress");
            }
            written += writeCount;
          }
          sourceOffset += count;
        }
        fsyncSync(destinationFd);
        chmodSync(command, 0o500);
        const copied = fstatSync(destinationFd);
        materializedIdentity = { dev: copied.dev, ino: copied.ino };
        closeSync(destinationFd);
        destinationFd = undefined;
        materialized = true;
        validateMacSnapshot(materializedIdentity);
      } catch (error) {
        if (destinationFd !== undefined) closeSync(destinationFd);
        try {
          unlinkSync(command);
        } catch {
          // Best-effort cleanup; the private directory removal below remains
          // fail-closed if another entry appeared.
        }
        try {
          rmdirSync(dirname(command));
        } catch {
          // Preserve the original materialization failure.
        }
        throw error;
      }
    };
    return {
      command,
      commandLifecycle: {
        // Descriptor execution is unavailable on macOS. Same-UID filesystem
        // attackers are outside the documented local-host trust boundary in
        // docs/durable-recovery.md. Keep the verified source on an unlinked
        // descriptor, rematerialize only at the syscall boundary (including
        // retries), then remove the executable pathname immediately.
        beforeSpawn: materializeForSpawn,
        afterSpawn() {
          validateMacSnapshot(materializedIdentity);
          unlinkSync(command);
          rmdirSync(dirname(command));
          materialized = false;
          materializedIdentity = undefined;
        },
      },
    };
  }
  throw new Error(
    `OpenCode ${QUALIFIED_OPENCODE_VERSION} runner-owned executable binding is unavailable; refusing ambient PATH or PAPERCLIP_OPENCODE_COMMAND fallback`,
  );
}
