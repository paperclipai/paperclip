import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInlineSourceFromPath } from "../commands/client/company.js";
import { createStoredZipArchive } from "./helpers/zip.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("resolveInlineSourceFromPath", () => {
  it("imports portable files from a zip archive instead of scanning the parent directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "odysseus-company-import-zip-"));
    tempDirs.push(tempDir);

    const archivePath = path.join(tempDir, "odysseus-demo.zip");
    const archive = createStoredZipArchive(
      {
        "COMPANY.md": "# Company\n",
        ".odysseus.yaml": "schema: odysseus/v1\n",
        "agents/ceo/AGENT.md": "# CEO\n",
        "notes/todo.txt": "ignore me\n",
      },
      "odysseus-demo",
    );
    await writeFile(archivePath, archive);

    const resolved = await resolveInlineSourceFromPath(archivePath);

    expect(resolved).toEqual({
      rootPath: "odysseus-demo",
      files: {
        "COMPANY.md": "# Company\n",
        ".odysseus.yaml": "schema: odysseus/v1\n",
        "agents/ceo/AGENT.md": "# CEO\n",
      },
    });
  });
});
