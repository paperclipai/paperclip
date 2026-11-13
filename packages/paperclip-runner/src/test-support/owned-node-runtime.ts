import { chmod, copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Copy the test host Node closure without changing its shared executable. */
export async function copyOwnedNodeRuntime(directory: string, source = process.execPath) {
  await mkdir(directory, { recursive: true });
  const executable = join(directory, "runtime");
  await copyFile(source, executable);
  await chmod(executable, 0o700);
  // Homebrew Node resolves its libnode dylib next to the relocated executable.
  const libraryRoot = join(dirname(source), "..", "lib");
  const libraries: string[] = [];
  const names = await readdir(libraryRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw new Error(`Cannot read Node fixture libraries at ${libraryRoot}`, { cause: error });
  });
  for (const name of names.filter(name => /^libnode\..*\.dylib$/.test(name))) {
    const library = join(directory, name);
    await copyFile(join(libraryRoot, name), library);
    await chmod(library, 0o600);
    libraries.push(library);
  }
  return { executable, libraries };
}
