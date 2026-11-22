import { installSocketDisconnectGuard } from "../../services/socket-disconnect-guard.js";

const mode = process.argv[2];

function logGuard(error: unknown) {
  process.stderr.write(`guard:${error instanceof Error ? error.name : String(error)}\n`);
}

if (mode === "crash") {
  installSocketDisconnectGuard(logGuard);
  process.on("uncaughtException", (error) => {
    process.stdout.write(`sentry:${error instanceof Error ? error.name : String(error)}\n`);
    process.exit(7);
  });
  setImmediate(() => {
    throw new TypeError("boom");
  });
} else {
  installSocketDisconnectGuard(logGuard);
  const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" });
  process.stderr.on("error", () => undefined);
  process.stdout.on("error", () => undefined);
  setImmediate(() => {
    throw error;
  });
  setTimeout(() => {
    process.stdout.write("alive\n");
    process.exit(0);
  }, 300);
}
