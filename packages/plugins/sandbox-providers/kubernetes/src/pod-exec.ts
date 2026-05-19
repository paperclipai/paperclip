/**
 * Exec a command inside a running pod container using the Kubernetes exec API.
 *
 * Uses @kubernetes/client-node's Exec class, which opens a WebSocket to the
 * kube-apiserver and streams stdout/stderr. The statusCallback receives a V1Status
 * with status="Success" or status="Failure" + details.causes[{reason:"ExitCode"}].
 *
 * NOTE: tty=false so stdout and stderr arrive on separate channels. If tty=true
 * were used, they would be merged onto stdout and the exit code would not be
 * reliable from the status callback on older cluster versions.
 */

import { Exec } from "@kubernetes/client-node";
import { PassThrough } from "node:stream";
import type { KubeConfig } from "@kubernetes/client-node";
import { shellQuoteArg } from "./shell-utils.js";

type WebSocketLike = {
  close(): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
};

export interface ExecInPodResult {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export async function execInPod(
  kc: KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
  stdin?: string | Buffer,
  timeoutMs?: number,
): Promise<ExecInPodResult> {
  const exec = new Exec(kc);
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();

  const stdinPayload: Buffer | null =
    Buffer.isBuffer(stdin) ? stdin
    : typeof stdin === "string" && stdin.length > 0 ? Buffer.from(stdin, "utf-8")
    : null;
  const stdinStream: PassThrough | null = stdinPayload ? new PassThrough() : null;
  const effectiveCommand = stdinPayload
    ? ["/bin/sh", "-c", buildStdinCommand(stdinPayload.length, command.map(shellQuoteArg).join(" "))]
    : command;

  let stdoutData = "";
  let stderrData = "";

  stdoutStream.on("data", (chunk: Buffer) => {
    stdoutData += chunk.toString("utf-8");
  });
  stderrStream.on("data", (chunk: Buffer) => {
    stderrData += chunk.toString("utf-8");
  });
  stdoutStream.on("error", () => {});
  stderrStream.on("error", () => {});

  return await new Promise<ExecInPodResult>(
    (resolve, reject) => {
      let ws: WebSocketLike | null = null;
      let settled = false;
      let pendingResult: Omit<ExecInPodResult, "stdout" | "stderr"> | null = null;
      let stdoutEnded = false;
      let stderrEnded = false;
      const timeout =
        typeof timeoutMs === "number" && timeoutMs > 0
          ? setTimeout(() => {
              finishWithTransportFailure(`Kubernetes exec timed out after ${timeoutMs}ms`, true);
            }, timeoutMs)
          : null;

      const finish = (result: ExecInPodResult) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        try {
          ws?.close();
        } catch {
          // Ignore best-effort close failures.
        }
        resolve(result);
      };
      const finishWithTransportFailure = (message: string, timedOut = false) => {
        const separator = stderrData.length > 0 && !stderrData.endsWith("\n") ? "\n" : "";
        finish({
          exitCode: 1,
          timedOut,
          stdout: stdoutData,
          stderr: `${stderrData}${separator}${message}`,
        });
      };
      const tryFinish = () => {
        if (settled || !pendingResult || !stdoutEnded || !stderrEnded) return;
        finish({
          ...pendingResult,
          stdout: stdoutData,
          stderr: stderrData,
        });
      };
      const endOutputStreams = () => {
        if (!stdoutStream.writableEnded) stdoutStream.end();
        if (!stderrStream.writableEnded) stderrStream.end();
      };

      stdoutStream.on("end", () => {
        stdoutEnded = true;
        tryFinish();
      });
      stderrStream.on("end", () => {
        stderrEnded = true;
        tryFinish();
      });

      const websocketPromise = exec
        .exec(
          namespace,
          podName,
          containerName,
          effectiveCommand,
          stdoutStream,
          stderrStream,
          stdinStream,
          false, // tty=false: keep stdout/stderr on separate channels
          (status) => {
            // status.status is "Success" | "Failure"
            if (status.status === "Success") {
              pendingResult = { exitCode: 0, timedOut: false };
              endOutputStreams();
              tryFinish();
              return;
            }
            // On failure, the exit code surfaces via
            // status.details?.causes[].{reason:"ExitCode", message:"<N>"}
            const causes = status.details?.causes ?? [];
            const exitCodeCause = causes.find(
              (c: { reason?: string; message?: string }) =>
                c.reason === "ExitCode",
            );
            const exitCode = exitCodeCause?.message
              ? Number(exitCodeCause.message)
              : 1;
            pendingResult = { exitCode, timedOut: false };
            endOutputStreams();
            tryFinish();
          },
        );

      websocketPromise
        .then((webSocket) => {
          ws = webSocket as WebSocketLike;
          if (settled) {
            try {
              ws.close();
            } catch {
              // Ignore best-effort close failures.
            }
            return;
          }
          if (stdinStream && stdinPayload) {
            stdinStream.end(stdinPayload);
          }
          ws.on("close", (code: number, reason: Buffer) => {
            if (settled || pendingResult) return;
            const reasonText = reason.length > 0 ? `: ${reason.toString("utf-8")}` : "";
            finishWithTransportFailure(`Kubernetes exec websocket closed before status frame (${code})${reasonText}`);
          });
          ws.on("error", (err: Error) => {
            if (settled || pendingResult) return;
            finishWithTransportFailure(`Kubernetes exec websocket failed before status frame: ${err.message}`);
          });
        })
        .catch((err) => {
          if (settled) return;
          if (timeout) clearTimeout(timeout);
          reject(err);
        });
    },
  );
}

function buildStdinCommand(byteCount: number, commandText: string): string {
  return [
    "if command -v head >/dev/null 2>&1; then",
    // byteCount is from the UTF-8 Buffer sent to stdin, so multibyte strings
    // are still counted as bytes rather than JavaScript string characters.
    `head -c ${byteCount} | ${commandText};`,
    "elif command -v dd >/dev/null 2>&1; then",
    `dd bs=1 count=${byteCount} 2>/dev/null | ${commandText};`,
    "else",
    "echo 'paperclip kubernetes exec stdin requires dd or head in the agent image' >&2;",
    "exit 127;",
    "fi",
  ].join(" ");
}
