import fs from "node:fs";
import { Writable } from "node:stream";
import pinoPretty from "pino-pretty";
import {
  defaultLoggingRotationConfig,
  type LoggingRotationConfig,
} from "@paperclipai/shared";
import {
  getMaxLogFileSizeBytes,
  normalizeLoggingRotationConfig,
  prepareLogFileForWrite,
  rotateActiveLogFile,
  type LogRotationWarningSink,
} from "./file-rotation.js";
import type { PrettyOptions } from "pino-pretty";

export type RotatingPrettyTargetOptions = Omit<PrettyOptions, "destination"> & {
  logFile: string;
  rotation?: Partial<LoggingRotationConfig>;
};

type RotatingFileStreamOptions = {
  logFile: string;
  rotation?: Partial<LoggingRotationConfig>;
  now?: () => Date;
  warn?: LogRotationWarningSink;
};

function defaultWarn(message: string, error?: unknown): void {
  if (error instanceof Error) {
    console.warn(`[logger] ${message}: ${error.message}`);
    return;
  }
  if (error !== undefined) {
    console.warn(`[logger] ${message}:`, error);
    return;
  }
  console.warn(`[logger] ${message}`);
}

function getChunkLength(chunk: Buffer | string, encoding: BufferEncoding): number {
  return Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
}

export class RotatingFileStream extends Writable {
  private readonly logFile: string;
  private readonly rotation: LoggingRotationConfig;
  private readonly now: () => Date;
  private readonly warn: LogRotationWarningSink;
  private currentSize: number;
  private destination: fs.WriteStream;

  constructor(options: RotatingFileStreamOptions) {
    super();
    this.logFile = options.logFile;
    this.rotation = normalizeLoggingRotationConfig(options.rotation ?? defaultLoggingRotationConfig);
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? defaultWarn;

    prepareLogFileForWrite({
      logFile: this.logFile,
      rotation: this.rotation,
      now: this.now,
      warn: this.warn,
    });

    this.currentSize = this.readCurrentSize();
    this.destination = this.openDestination();
  }

  private readCurrentSize(): number {
    try {
      return fs.statSync(this.logFile).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  private openDestination(): fs.WriteStream {
    return fs.createWriteStream(this.logFile, { flags: "a" });
  }

  private shouldRotate(nextChunkLength: number): boolean {
    if (!this.rotation.enabled || this.currentSize === 0) return false;
    return this.currentSize + nextChunkLength > getMaxLogFileSizeBytes(this.rotation);
  }

  private reopenDestination(): void {
    this.destination = this.openDestination();
    this.currentSize = this.readCurrentSize();
  }

  private rotateBeforeWrite(callback: (error?: Error | null) => void): void {
    const currentDestination = this.destination;

    currentDestination.end((closeError?: Error | null) => {
      if (closeError) {
        callback(closeError);
        return;
      }

      try {
        rotateActiveLogFile({
          logFile: this.logFile,
          rotation: this.rotation,
          now: this.now,
          warn: this.warn,
        });
      } catch (error) {
        this.warn(`failed to rotate ${this.logFile}`, error);
      }

      try {
        this.reopenDestination();
      } catch (error) {
        callback(error as Error);
        return;
      }

      callback();
    });
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const nextChunkLength = getChunkLength(chunk, encoding);
    const writeChunk = () => {
      this.destination.write(chunk, encoding, (error) => {
        if (!error) {
          this.currentSize += nextChunkLength;
        }
        callback(error ?? undefined);
      });
    };

    if (!this.shouldRotate(nextChunkLength)) {
      writeChunk();
      return;
    }

    this.rotateBeforeWrite((error) => {
      if (error) {
        callback(error);
        return;
      }
      writeChunk();
    });
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.destination.end((error?: Error | null) => callback(error ?? undefined));
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.destination.destroyed) {
      callback(error);
      return;
    }

    this.destination.once("close", () => callback(error));
    this.destination.destroy(error ?? undefined);
  }
}

export default function buildRotatingPrettyTarget(options: RotatingPrettyTargetOptions) {
  const { logFile, rotation, ...prettyOptions } = options;
  return pinoPretty.build({
    ...prettyOptions,
    destination: new RotatingFileStream({
      logFile,
      rotation,
    }),
  });
}
