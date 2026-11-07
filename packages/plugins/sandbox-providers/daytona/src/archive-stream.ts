import { randomUUID } from "node:crypto";
import { open, statfs } from "node:fs/promises";
import { openDaytonaDuplexChannelSession, type DaytonaPtyProcess, type DuplexChannelSession } from "./duplex-command-stream.js";

const CHUNK_BYTES = 40 * 1024;
const CREDIT_WINDOW = 16;
const MAX_FRAME_BYTES = Math.ceil(CHUNK_BYTES / 3) * 4 + 128;
const MAX_BUFFER_BYTES = MAX_FRAME_BYTES * CREDIT_WINDOW;
const HOST_FREE_RESERVE_BYTES = 1024 ** 3;
const CLEANUP_TIMEOUT_MS = 5_000;
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

async function closeArchiveSession(session: DuplexChannelSession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.close().catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function streamSandboxArchive(input: {
  process: DaytonaPtyProcess;
  cwd: string;
  archiveScript: string;
  destination: string;
  timeoutSeconds: number;
  maxBytes: number;
}): Promise<void> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new Error("Daytona archive stream requires a verified sandbox disk budget");
  }
  const marker = `paperclip-archive-${randomUUID()}`;
  const ready = `${marker}:ready`;
  const start = `${marker}:start`;
  const done = `${marker}:done`;
  // fd 3 retains the PTY input while tar owns the pipeline's stdin. pipefail
  // preserves tar failure even when the last encoder completes successfully.
  const receiveAcknowledgements = [
    'while [ "$outstanding" -gt 0 ]; do',
    `IFS= read -r ack <&3 && [ "$ack" = ${quote(marker)} ] || exit 1;`,
    'outstanding=$((outstanding - 1));',
    "done",
  ].join(" ");
  const sender = [
    "outstanding=0;",
    "while :; do",
    `chunk=$(dd bs=${CHUNK_BYTES} count=1 iflag=fullblock status=none | base64 -w 0) || exit 1;`,
    '[ -n "$chunk" ] || break;',
    'printf "data:%s\\n" "$chunk";',
    "outstanding=$((outstanding + 1));",
    `if [ "$outstanding" -eq ${CREDIT_WINDOW} ]; then ${receiveAcknowledgements}; fi;`,
    "done;",
    receiveAcknowledgements,
  ].join(" ");
  // Duplicate the original input before constructing the tar pipeline.
  const command = `exec 3<&0; printf '\\n%s\\n' ${quote(start)}; { ${input.archiveScript}; } | ( ${sender} ); `;
  const launch = `${command}status=$?; [ "$status" -eq 0 ] || exit "$status"; ` +
    `printf '%s\\n' ${quote(done)}; IFS= read -r ack <&3 && [ "$ack" = ${quote(done)} ]`;
  const file = await open(input.destination, "w", 0o600);
  let session: DuplexChannelSession | undefined;
  let stopped = false;
  let started = false;
  let launched = false;
  let complete = false;
  let pendingFrames = 0;
  let buffer = "";
  let receivedBytes = 0;
  let pending = Promise.resolve();
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  const fail = (message: string) => rejectFailure(new Error(message));
  const timer = setTimeout(() => fail("Daytona archive stream timed out"), input.timeoutSeconds * 1000);
  const transfer = async () => {
    session = await openDaytonaDuplexChannelSession(input.process,
      ["bash", "--noprofile", "--norc", "-o", "pipefail", "-c",
        `printf '\\n%s\\n' ${quote(ready)}; IFS= read -r script && eval "$(printf %s \"$script\" | base64 -d)"`],
      { cwd: input.cwd, diagnosticsPath: "/dev/null" });
    if (stopped) { await closeArchiveSession(session); return; }
    session.onData(bytes => {
      if (stopped) return;
      buffer += Buffer.from(bytes).toString("utf8");
      if (buffer.length > MAX_BUFFER_BYTES) { fail("Daytona archive stream exceeded its buffer limit"); return; }
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        // The bootstrap confirms raw mode before sending the potentially long
        // archive script, which would exceed a canonical terminal's line cap.
        if (!launched && line === ready) {
          launched = true;
          session!.write(Buffer.from(`${Buffer.from(launch).toString("base64")}\n`));
          continue;
        }
        if (!started) { if (line === start) started = true; continue; }
        if (line === done && !complete && pendingFrames === 0) {
          complete = true;
          session!.write(Buffer.from(`${done}\n`));
          continue;
        }
        if (!line || complete || !line.startsWith("data:")) { fail("Invalid Daytona archive stream frame"); return; }
        if (pendingFrames >= CREDIT_WINDOW) { fail("Daytona archive stream exceeded its pending frame limit"); return; }
        const encoded = line.slice(5);
        const data = Buffer.from(encoded, "base64");
        if (!data.length || data.length > CHUNK_BYTES || data.toString("base64") !== encoded) {
          fail("Invalid Daytona archive stream payload"); return;
        }
        pendingFrames += 1;
        pending = pending.then(async () => {
          if (stopped) return;
          if (receivedBytes + data.length > input.maxBytes) {
            throw new Error("Daytona archive stream exceeds the sandbox disk budget");
          }
          const available = await statfs(input.destination);
          if (available.bavail * available.bsize - data.length < HOST_FREE_RESERVE_BYTES) {
            throw new Error("Daytona archive stream would exhaust the host free-space reserve");
          }
          if (stopped) return;
          await file.writeFile(data);
          receivedBytes += data.length;
          pendingFrames -= 1;
          session!.write(Buffer.from(`${marker}\n`));
        }).catch(error => { stopped = true; rejectFailure(error); });
      }
    });
    const exit = await session.wait();
    await pending;
    if (exit.exitCode !== 0 || exit.transportClosed || !complete || buffer.trim()) {
      throw new Error(`Daytona archive stream ended without a successful archive receipt (exit=${exit.exitCode ?? "unknown"}, started=${started}, complete=${complete}, pendingBytes=${buffer.length})`);
    }
  };
  try {
    await Promise.race([transfer(), failure]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    const cleanup = session ? closeArchiveSession(session) : Promise.resolve();
    try {
      await pending;
    } finally {
      await file.close();
      await cleanup;
    }
  }
}
