import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ACPX_SIDECAR_PROTOCOL_VERSION } from "../drivers/acpx/sidecar-protocol.js";

export function initializeRequest(
  id: number,
  agent: string,
  model = "gpt-5.6-sol",
) {
  return {
    protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
    id,
    command: "initialize",
    params: { agent, model },
  };
}

export class SidecarProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #frames: Array<Record<string, unknown>> = [];
  readonly #signals: Array<() => void> = [];
  #stderr = "";
  #closed = false;
  readonly #exit: Promise<{code:number|null;signal:NodeJS.Signals|null}>;

  constructor(options: {loader?:string;environment?:Record<string,string>} = {}) {
    this.#child = spawn(
      options.loader ? process.execPath : fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url)),
      [...(options.loader ? ["--import","tsx","--import",options.loader] : []), fileURLToPath(new URL("../cli/acpx-runtime-sidecar.ts", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, LANG: "C.UTF-8", ...options.environment } },
    );
    this.#exit = new Promise(resolve => this.#child.once("exit", (code, signal) => resolve({code,signal})));
    let stdout = "";
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        this.#frames.push(JSON.parse(line) as Record<string, unknown>);
        for (const signal of this.#signals.splice(0)) signal();
      }
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
  }

  write(value: Record<string, unknown>): void {
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  closeOutput(): void {
    this.#child.stdout.destroy();
  }

  async shutdown(trigger: "stdin" | "SIGTERM" | "SIGINT") {
    if (trigger === "stdin") this.#child.stdin.end();
    else this.#child.kill(trigger);
    return this.exited();
  }

  async exited() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Sidecar did not exit without forced cleanup")), 5000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  stderr(): string {
    return this.#stderr;
  }

  pending(predicate: (frame: Record<string, unknown>) => boolean): number {
    return this.#frames.filter(predicate).length;
  }

  async next(
    predicate: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const index = this.#frames.findIndex(predicate);
      if (index >= 0) return this.#frames.splice(index, 1)[0]!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for sidecar frame. stderr=${JSON.stringify(this.#stderr)}`,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = this.#signals.indexOf(signal);
          if (index >= 0) this.#signals.splice(index, 1);
          reject(new Error("Timed out waiting for sidecar output"));
        }, remaining);
        const signal = () => {
          clearTimeout(timer);
          resolve();
        };
        this.#signals.push(signal);
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed || this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    this.#closed = true;
    this.#child.stdin.end();
    const exit = new Promise<void>((resolve) => {
      this.#child.once("exit", () => resolve());
    });
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.#child.exitCode === null) this.#child.kill("SIGKILL");
        resolve();
      }, 2_000).unref();
    });
    await Promise.race([exit, timeout]);
  }
}
