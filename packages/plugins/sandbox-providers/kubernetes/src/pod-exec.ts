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

export async function execInPod(
  kc: KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
  stdin?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

  return await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      exec
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
              resolve({ exitCode: 0, stdout: stdoutData, stderr: stderrData });
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
            resolve({ exitCode, stdout: stdoutData, stderr: stderrData });
          },
        )
        .catch(reject);
    },
  );
}
