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
  stdin?: string,
  timeoutMs?: number,
): Promise<ExecInPodResult> {
  const exec = new Exec(kc);
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();

  // If stdin is provided build a readable stream from it; the Exec API accepts
  // a Readable | null for stdin.
  const stdinStream: import("node:stream").Readable | null = stdin
    ? PassThrough.from(stdin)
    : null;

  let stdoutData = "";
  let stderrData = "";

  stdoutStream.on("data", (chunk: Buffer) => {
    stdoutData += chunk.toString("utf-8");
  });
  stderrStream.on("data", (chunk: Buffer) => {
    stderrData += chunk.toString("utf-8");
  });

  return await new Promise<ExecInPodResult>(
    (resolve, reject) => {
      let settled = false;
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

      const websocketPromise = exec
        .exec(
          namespace,
          podName,
          containerName,
          command,
          stdoutStream,
          stderrStream,
          stdinStream,
          false, // tty=false: keep stdout/stderr on separate channels
          (status) => {
            // status.status is "Success" | "Failure"
            if (status.status === "Success") {
              finish({ exitCode: 0, timedOut: false, stdout: stdoutData, stderr: stderrData });
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
            finish({ exitCode, timedOut: false, stdout: stdoutData, stderr: stderrData });
          },
        );

      websocketPromise
        .then((ws) => {
          ws.on("close", (code: number, reason: Buffer) => {
            if (settled) return;
            const reasonText = reason.length > 0 ? `: ${reason.toString("utf-8")}` : "";
            finishWithTransportFailure(`Kubernetes exec websocket closed before status frame (${code})${reasonText}`);
          });
          ws.on("error", (err: Error) => {
            if (settled) return;
            finishWithTransportFailure(`Kubernetes exec websocket failed before status frame: ${err.message}`);
          });
        })
        .catch((err) => {
          if (settled) return;
          reject(err);
        });
    },
  );
}
