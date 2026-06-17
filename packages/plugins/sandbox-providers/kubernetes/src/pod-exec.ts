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
 *
 * Stdin handling: @kubernetes/client-node v1.x attaches `stdin.on("end", ()
 * => ws.close())`, which closes the entire WebSocket as soon as our PassThrough
 * ends — BEFORE the pod's command has a chance to flush and BEFORE the
 * statusCallback fires. We work around this by removing that listener after
 * exec setup completes so EOF on stdin only signals the pod (via a stdin-
 * channel close frame implicit in our flow) without tearing down the
 * connection. We then close the WebSocket explicitly inside the statusCallback.
 */

import { Exec } from "@kubernetes/client-node";
import { PassThrough } from "node:stream";
import type { KubeConfig } from "@kubernetes/client-node";

// Minimal WebSocket-like shape covering what we touch (close()). The full type
// comes from @kubernetes/client-node's transitive ws/isomorphic-ws dep but
// importing it directly couples this file to that internal choice.
type WebSocketLike = { close(): void };

// Single-quote a string for safe interpolation into a sh -c script. Wraps in
// '...' and escapes any embedded single quotes via '\'' (close, escape, reopen).
export function shQuote(segment: string): string {
  return `'${segment.replace(/'/g, "'\\''")}'`;
}

// Wrap a command so the given env vars are exported before it runs. The Kubernetes
// exec API has no env field, so the only way to give an exec'd process additional
// env is to run it under a shell that exports the vars and then `exec`s the real
// command. PATH is deliberately skipped (the caller's PATH is the orchestrator's,
// not the sandbox image's, and overriding it would break command resolution), and
// only valid shell identifiers are exported. Returns the original command unchanged
// when there is nothing to apply.
export function wrapCommandWithEnv(
  command: string[],
  env: Record<string, string> | undefined | null,
): string[] {
  const entries = Object.entries(env && typeof env === "object" ? env : {}).filter(
    ([key, value]) =>
      typeof value === "string" && key !== "PATH" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
  );
  if (entries.length === 0) return command;
  const exports = entries.map(([k, v]) => `export ${k}=${shQuote(v)};`).join(" ");
  return ["/bin/sh", "-c", `${exports} exec ${command.map(shQuote).join(" ")}`];
}

export async function execInPod(
  kc: KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
  stdin?: string | Buffer,
  timeoutMs?: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const exec = new Exec(kc);
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();

  const stdinPayload: Buffer | null =
    Buffer.isBuffer(stdin) ? stdin
    : typeof stdin === "string" && stdin.length > 0 ? Buffer.from(stdin, "utf-8")
    : null;
  const stdinStream: PassThrough | null = stdinPayload ? new PassThrough() : null;

  // When stdin is provided, wrap the command so its stdin is bounded by
  // `head -c <N>`. Any program reading stdin (`cat`, `claude --print -`,
  // `base64 -d`, etc.) waits for EOF to terminate the read. With the k8s
  // client v0.21.0 stdin-end -> ws.close() limitation (see comment above)
  // we can't reliably deliver EOF without tearing down the exec — so we
  // pipe `head -c <N>` (which exits after exactly N bytes) into the
  // original command. The pipe propagates the exit code of the RHS so the
  // statusCallback still reflects the real command's exit status.
  //
  // NOTE: `stdinPayload.length` is the Buffer's BYTE length (correct for
  // `head -c` which counts bytes). Do NOT substitute `string.length` here
  // if the input is ever non-ASCII — UTF-8 multi-byte sequences would
  // give a byte count that differs from JS character count.
  const effectiveCommand = stdinPayload
    ? ["/bin/sh", "-c", `head -c ${stdinPayload.length} | ${command.map(shQuote).join(" ")}`]
    : command;

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
      let ws: WebSocketLike | null = null;
      let resolved = false;
      let pendingExitCode: number | null = null;
      let stdoutEnded = false;
      let stderrEnded = false;

      // The k8s client writes stdout/stderr to our PassThroughs synchronously
      // and calls statusCallback in the same WS message handler. But `data`
      // events on the PassThroughs fire on process.nextTick, so resolving
      // inside statusCallback captures stdoutData/stderrData BEFORE the final
      // bytes have been appended. Wait for both streams' `end` events (which
      // the k8s client triggers via `stream.end()` when it processes the
      // status frame) so all buffered data has been drained into our string
      // accumulators before resolving.
      //
      // Watchdog: if the WebSocket drops silently after setup (network blip,
      // pod OOM-killed mid-exec, apiserver restart) the statusCallback never
      // fires and the stream `end` events never arrive. Without a timer the
      // calling worker hangs forever. Reject with a clear error so the caller
      // can retry or surface the failure.
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      if (typeof timeoutMs === "number" && timeoutMs > 0) {
        watchdog = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          try { ws?.close(); } catch { /* ignore */ }
          reject(new Error(
            `execInPod timed out after ${timeoutMs}ms (pod=${podName}, container=${containerName}, cmd0=${effectiveCommand[0] ?? ""}). The WebSocket likely dropped before the command produced a status frame.`,
          ));
        }, timeoutMs);
      }

      const tryFinish = () => {
        if (resolved) return;
        if (pendingExitCode === null) return;
        if (!stdoutEnded || !stderrEnded) return;
        resolved = true;
        if (watchdog) clearTimeout(watchdog);
        try { ws?.close(); } catch { /* ignore */ }
        resolve({ exitCode: pendingExitCode, stdout: stdoutData, stderr: stderrData });
      };

      stdoutStream.on("end", () => { stdoutEnded = true; tryFinish(); });
      stderrStream.on("end", () => { stderrEnded = true; tryFinish(); });

      const execPromise = exec.exec(
        namespace,
        podName,
        containerName,
        effectiveCommand,
        stdoutStream,
        stderrStream,
        stdinStream,
        false, // tty=false: keep stdout/stderr on separate channels
        (status) => {
          if (status.status === "Success") {
            pendingExitCode = 0;
          } else {
            const causes = status.details?.causes ?? [];
            const exitCodeCause = causes.find(
              (c: { reason?: string; message?: string }) =>
                c.reason === "ExitCode",
            );
            pendingExitCode = exitCodeCause?.message
              ? Number(exitCodeCause.message)
              : 1;
          }
          tryFinish();
        },
      );

      execPromise
        .then((webSocket) => {
          ws = webSocket as unknown as WebSocketLike;
          if (stdinStream && stdinPayload) {
            // Remove the default `end -> ws.close()` listener that k8s client
            // attaches in handleStandardInput; it tears down the connection
            // before the pod's command can finish flushing. We manage ws
            // closure inside `tryFinish()` instead.
            stdinStream.removeAllListeners("end");
            stdinStream.end(stdinPayload);
          } else if (stdinStream) {
            stdinStream.removeAllListeners("end");
            stdinStream.end();
          }
        })
        .catch((err) => {
          if (resolved) return;
          resolved = true;
          if (watchdog) clearTimeout(watchdog);
          reject(err);
        });
    },
  );
}
