import fs from "node:fs/promises";
import path from "node:path";

const AGENT_HOME_DIRECTORIES = [
  ".omx",
  path.join(".omx", "logs"),
  path.join(".omx", "plans"),
  path.join(".omx", "state"),
];

const AGENT_HOME_FILES: Array<{ relativePath: string; contents: string }> = [
  {
    relativePath: path.join(".omx", "notepad.md"),
    contents: `# Notepad

## Priority Context

## Working Memory

## Manual
`,
  },
  {
    relativePath: path.join(".omx", "project-memory.json"),
    contents: "{}\n",
  },
];

async function writeFileIfMissing(filePath: string, contents: string) {
  try {
    await fs.writeFile(filePath, contents, { flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "EEXIST") throw error;
  }
}

export async function ensureAgentHomeScaffold(cwd: string): Promise<void> {
  for (const relativeDir of AGENT_HOME_DIRECTORIES) {
    await fs.mkdir(path.join(cwd, relativeDir), { recursive: true });
  }

  for (const file of AGENT_HOME_FILES) {
    await writeFileIfMissing(path.join(cwd, file.relativePath), file.contents);
  }
}
