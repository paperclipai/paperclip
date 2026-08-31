import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
const source = path.join(packageRoot, "runner", "target", "release", executable);
const destinationDirectory = path.join(packageRoot, "dist", "bin");
const destination = path.join(destinationDirectory, executable);

await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, destination);
if (process.platform !== "win32") await chmod(destination, 0o755);
