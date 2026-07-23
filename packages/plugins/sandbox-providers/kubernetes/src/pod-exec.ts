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
import type { Readable, Writable } from "node:stream";
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
  // Optional host-side bound on accumulated stdout. The pod is an untrusted,
  // attacker-controlled endpoint: a malicious pod can emit unbounded stdout
  // during an exec (e.g. a native file-sync `syncOut` tarball), which would grow
  // the in-memory accumulator without limit — blowing up the worker's RSS and,
  // past V8's ~512 MB max string length, throwing a synchronous RangeError inside
  // the stream `data` listener that no caller can catch (an uncaught exception =
  // worker crash = cross-tenant DoS). When set, accumulation fails closed the
  // instant it would exceed the cap so the caller can fall back. In-pod size
  // checks are worthless here — only the host can be trusted to enforce this.
  maxStdoutBytes?: number,
  // Same bound for the stderr channel. stderr is equally pod-controlled: a
  // malicious pod can emit an unbounded stderr stream during the SAME exec (e.g.
  // crafted tar/realpath diagnostics on the `syncOut` path) and trigger the
  // identical uncaught-`RangeError` worker crash. When set, stderr accumulation
  // fails closed at the cap; regardless of the cap, the `+=` is guarded so a
  // max-string-length `RangeError` can never escape as an uncaught exception.
  maxStderrBytes?: number,
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
  let stdoutBytes = 0;
  let stderrBytes = 0;

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

      // Fail the whole exec closed, tearing down the WebSocket so the pod stops
      // streaming. Used by the stdout cap below; the `resolved` guard makes it a
      // no-op if the exec already finished.
      const failClosed = (err: Error) => {
        if (resolved) return;
        resolved = true;
        if (watchdog) clearTimeout(watchdog);
        try { ws?.close(); } catch { /* ignore */ }
        reject(err);
      };

      // Accumulate stdout inside the executor so the cap can reject before an
      // unbounded pod payload exhausts memory. Once resolved (finished, timed
      // out, or capped) further chunks are dropped rather than appended.
      stdoutStream.on("data", (chunk: Buffer) => {
        if (resolved) return;
        if (typeof maxStdoutBytes === "number" && maxStdoutBytes >= 0) {
          stdoutBytes += chunk.length;
          if (stdoutBytes > maxStdoutBytes) {
            failClosed(new Error(
              `execInPod stdout exceeded the ${maxStdoutBytes}-byte cap (pod=${podName}, container=${containerName}); the sandbox produced more output than the buffer allows.`,
            ));
            return;
          }
        }
        try {
          stdoutData += chunk.toString("utf-8");
        } catch (err) {
          // Belt-and-suspenders: even under an explicit cap (or with none set),
          // never let a `+=` RangeError at V8's max string length escape this
          // listener as an uncaught exception.
          failClosed(err instanceof Error ? err : new Error(String(err)));
        }
      });

      // stderr is pod-controlled too — bound it with the same fail-closed policy
      // and, unconditionally, guard the `+=` so a max-string-length `RangeError`
      // can never escape this listener as an uncaught (worker-crashing) exception.
      stderrStream.on("data", (chunk: Buffer) => {
        if (resolved) return;
        if (typeof maxStderrBytes === "number" && maxStderrBytes >= 0) {
          stderrBytes += chunk.length;
          if (stderrBytes > maxStderrBytes) {
            failClosed(new Error(
              `execInPod stderr exceeded the ${maxStderrBytes}-byte cap (pod=${podName}, container=${containerName}); the sandbox produced more output than the buffer allows.`,
            ));
            return;
          }
        }
        try {
          stderrData += chunk.toString("utf-8");
        } catch (err) {
          failClosed(err instanceof Error ? err : new Error(String(err)));
        }
      });

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

/**
 * Streaming variant of {@link execInPod} for bulk file transfer over the pod
 * exec data channel.
 *
 * Where `execInPod` buffers the command's whole stdout into an in-memory string
 * (fine for small command output, fatal for a multi-gigabyte tar), this variant
 * PIPES the exec's stdin from a caller `Readable` and its stdout into a caller
 * `Writable` — so a native file-sync `syncIn`/`syncOut` streams raw tar bytes
 * straight to/from a host file on disk and neither the host nor the pod ever
 * holds the whole payload in memory. Both are intentionally kept side by side:
 * `execInPod` still backs the `environmentExecute` path unchanged.
 *
 * stderr is still accumulated into a (bounded) string: it carries only the
 * script's fail-loud diagnostics, and the pod controls how many bytes it emits,
 * so `maxStderrBytes` fails the exec closed the instant the pod floods the
 * channel — the same DoS guard `execInPod` applies. stdout carries no such cap
 * here because it is streamed to disk, not a string; the caller bounds it with
 * its own streamed-bytes guard on the sink `Writable`.
 *
 * Stdin EOF: the same k8s-client `stdin.on("end", () => ws.close())` quirk noted
 * on `execInPod` applies, so we strip that listener and drive the pod command to
 * self-terminate on the byte count instead of relying on EOF (the caller's
 * `syncIn` script bounds its read with `head -c <N>`). We close the WebSocket
 * ourselves from the status callback.
 *
 * Resolves once the command's exit status is known AND both the stdout sink has
 * finished draining and stderr has ended, so a caller that reads the sink file
 * back after `await` always sees the complete archive.
 */
export async function execInPodStreaming(
  kc: KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
  io: {
    stdin?: Readable;
    stdout?: Writable;
    timeoutMs?: number;
    maxStderrBytes?: number;
  },
): Promise<{ exitCode: number; stderr: string }> {
  const exec = new Exec(kc);
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  const stdinStream: PassThrough | null = io.stdin ? new PassThrough() : null;

  let stderrData = "";
  let stderrBytes = 0;

  return await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
    let ws: WebSocketLike | null = null;
    let resolved = false;
    let pendingExitCode: number | null = null;
    let stdoutDone = false;
    let stderrEnded = false;

    let watchdog: ReturnType<typeof setTimeout> | null = null;
    if (typeof io.timeoutMs === "number" && io.timeoutMs > 0) {
      watchdog = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try { ws?.close(); } catch { /* ignore */ }
        reject(new Error(
          `execInPodStreaming timed out after ${io.timeoutMs}ms (pod=${podName}, container=${containerName}, cmd0=${command[0] ?? ""}). The WebSocket likely dropped before the command produced a status frame.`,
        ));
      }, io.timeoutMs);
    }

    const tryFinish = () => {
      if (resolved) return;
      if (pendingExitCode === null) return;
      if (!stdoutDone || !stderrEnded) return;
      resolved = true;
      if (watchdog) clearTimeout(watchdog);
      try { ws?.close(); } catch { /* ignore */ }
      resolve({ exitCode: pendingExitCode, stderr: stderrData });
    };

    // Fail the whole exec closed, tearing down the WebSocket so the pod stops
    // streaming. Fired by a sink error (e.g. the caller's disk guard tripping)
    // or a stream error; the `resolved` guard makes it a no-op once finished.
    const failClosed = (err: Error) => {
      if (resolved) return;
      resolved = true;
      if (watchdog) clearTimeout(watchdog);
      try { ws?.close(); } catch { /* ignore */ }
      try { stdinStream?.destroy(); } catch { /* ignore */ }
      reject(err);
    };

    // Pipe stdout to the caller sink (streamed to disk), or drain it if the
    // caller wants none. Piping with the default `end: true` ends the sink when
    // the pod's stdout closes, so the sink's `finish` marks the archive fully
    // written. A sink error (the caller's streamed-bytes guard, a full disk)
    // fails the exec closed and stops the pod.
    if (io.stdout) {
      const sink = io.stdout;
      sink.on("error", failClosed);
      stdoutStream.on("error", failClosed);
      sink.on("finish", () => { stdoutDone = true; tryFinish(); });
      stdoutStream.pipe(sink);
    } else {
      stdoutStream.on("data", () => { /* drain */ });
      stdoutStream.on("end", () => { stdoutDone = true; tryFinish(); });
      stdoutStream.on("error", failClosed);
    }

    // stderr is pod-controlled — bound it with the same fail-closed policy as
    // execInPod and guard the `+=` so a max-string-length RangeError can never
    // escape as an uncaught (worker-crashing) exception.
    stderrStream.on("data", (chunk: Buffer) => {
      if (resolved) return;
      if (typeof io.maxStderrBytes === "number" && io.maxStderrBytes >= 0) {
        stderrBytes += chunk.length;
        if (stderrBytes > io.maxStderrBytes) {
          failClosed(new Error(
            `execInPodStreaming stderr exceeded the ${io.maxStderrBytes}-byte cap (pod=${podName}, container=${containerName}); the sandbox produced more diagnostics than the buffer allows.`,
          ));
          return;
        }
      }
      try {
        stderrData += chunk.toString("utf-8");
      } catch (err) {
        failClosed(err instanceof Error ? err : new Error(String(err)));
      }
    });
    stderrStream.on("end", () => { stderrEnded = true; tryFinish(); });

    const execPromise = exec.exec(
      namespace,
      podName,
      containerName,
      command,
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
            (c: { reason?: string; message?: string }) => c.reason === "ExitCode",
          );
          pendingExitCode = exitCodeCause?.message ? Number(exitCodeCause.message) : 1;
        }
        tryFinish();
      },
    );

    execPromise
      .then((webSocket) => {
        ws = webSocket as unknown as WebSocketLike;
        if (stdinStream && io.stdin) {
          // Strip the default `end -> ws.close()` listener (see execInPod) so
          // EOF on our stdin only signals the pod, then stream the caller's
          // source into the exec stdin channel. A source error fails closed.
          stdinStream.removeAllListeners("end");
          io.stdin.on("error", failClosed);
          io.stdin.pipe(stdinStream);
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
  });
}
