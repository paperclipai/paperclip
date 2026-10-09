import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0) {
  throw new Error("Usage: node copy-files.mjs <source> <destination> [...]");
}

for (let index = 0; index < args.length; index += 2) {
  const source = resolve(process.cwd(), args[index]);
  const destination = resolve(process.cwd(), args[index + 1]);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
