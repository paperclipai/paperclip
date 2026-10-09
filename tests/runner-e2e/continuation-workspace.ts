import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";

/** Seed the realized agent workspace, which can differ from the harness cwd. */
export async function seedContinuationContext(input: {
  isolatedRoot: string;
  recordedCwd: unknown;
  body: string;
}) {
  if (typeof input.recordedCwd !== "string" || !path.isAbsolute(input.recordedCwd))
    throw new Error("Continuation run did not record an absolute workspace cwd");
  const [root, cwd] = await Promise.all([
    realpath(input.isolatedRoot),
    realpath(input.recordedCwd),
  ]);
  const relative = path.relative(root, cwd);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Continuation workspace escaped the isolated instance");
  const file = path.join(cwd, "context.txt");
  await writeFile(file, input.body, { flag: "wx" });
  return file;
}
