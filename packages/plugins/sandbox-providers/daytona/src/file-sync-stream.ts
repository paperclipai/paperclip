import { spawn } from "node:child_process";
import { open, opendir } from "node:fs/promises";

/** NUL-delimited disk catalog; filenames never become a growing argv array. */
export async function writeTopLevelNames(directory: string, destination: string): Promise<void> {
  const file = await open(destination, "wx", 0o600);
  try {
    for await (const entry of await opendir(directory, { bufferSize: 128 })) await file.writeFile(`./${entry.name}\0`);
  } finally { await file.close(); }
}

/** Stream a tar listing with a per-entry bound instead of a total listing cap. */
export async function visitCommandLines(command: string, args: string[], visit: (line: string) => void): Promise<void> {
  const child = spawn(command, args, { env: { ...process.env, COPYFILE_DISABLE: "1", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
  let pending = "", diagnosticBytes = 0;
  const maxLine = 64 * 1024;
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error("Daytona sync archive listing failed")));
  });
  void finished.catch(() => undefined);
  child.stderr.on("data", (chunk: Buffer) => { diagnosticBytes += chunk.length; if (diagnosticBytes > maxLine) child.kill(); });
  child.stdout.setEncoding("utf8");
  try {
    for await (const chunk of child.stdout) {
      pending += String(chunk); let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        if (end > maxLine) throw new Error("Daytona sync archive entry listing too long");
        visit(pending.slice(0, end)); pending = pending.slice(end + 1);
      }
      if (pending.length > maxLine) throw new Error("Daytona sync archive entry listing too long");
    }
    if (pending) visit(pending);
    await finished;
    if (diagnosticBytes > maxLine) throw new Error("Daytona sync archive listing failed");
  } catch (error) { child.kill(); await finished.catch(() => undefined); throw error; }
}
