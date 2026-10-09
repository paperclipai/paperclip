import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(packageRoot, "src", "migrations");
const destination = join(packageRoot, "dist", "migrations");

await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, "meta"), { recursive: true });

const migrationFiles = (await readdir(source)).filter((file) => file.endsWith(".sql"));
await Promise.all(
  migrationFiles.map((file) => cp(join(source, file), join(destination, file))),
);
await cp(
  join(source, "meta", "_journal.json"),
  join(destination, "meta", "_journal.json"),
);
