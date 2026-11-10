import { closeSync, constants, fsyncSync, openSync, writeSync } from "node:fs";

/** Controller-owned evidence outside disposable server storage. No credentials. */
export class AttemptJournal {
  #fd: number | null;
  #bytes = 0;
  constructor(path: string, readonly maxBytes = 64 * 1024 * 1024) {
    this.#fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  }
  append(value: unknown): void {
    if (this.#fd === null) throw new Error("Attempt journal is closed");
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (this.#bytes + bytes.length > this.maxBytes) throw new Error("Attempt journal limit reached; stop provider dispatch");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.#fd, bytes, offset, bytes.length - offset);
    fsyncSync(this.#fd);
    this.#bytes += bytes.length;
  }
  close(): void {
    if (this.#fd !== null) closeSync(this.#fd);
    this.#fd = null;
  }
}
