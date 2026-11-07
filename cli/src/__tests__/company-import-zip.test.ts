import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-company-import-zip-"));
    tempDirs.push(tempDir);

    const blobBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const archivePath = path.join(tempDir, "paperclip-demo.zip");
    const archive = createStoredZipArchive(
      {
        "COMPANY.md": "# Company\n",
        ".paperclip.yaml": "schema: paperclip/v1\n",
        "agents/ceo/AGENT.md": "# CEO\n",
        "skills/compliance/SKILL.md": "# Compliance\n",
        "skills/compliance/scripts/scan.mjs": "export {};\n",
        "blobs/4f2d1c9a": blobBytes,
        "notes/todo.txt": "ignore me\n",
      },
      "paperclip-demo",
    );
    await writeFile(archivePath, archive);

    const resolved = await resolveInlineSourceFromPath(archivePath);

    expect(resolved).toEqual({
      rootPath: "paperclip-demo",
      files: {
        "COMPANY.md": "# Company\n",
        ".paperclip.yaml": "schema: paperclip/v1\n",
        "agents/ceo/AGENT.md": "# CEO\n",
        "skills/compliance/SKILL.md": "# Compliance\n",
        "skills/compliance/scripts/scan.mjs": "export {};\n",
        "blobs/4f2d1c9a": {
          encoding: "base64",
          data: Buffer.from(blobBytes).toString("base64"),
          contentType: "application/octet-stream",
        },
      },
    });
  });

  it("keeps skill scripts, references, templates, and assets while filtering unrelated source files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-company-import-skill-files-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "skills", "compliance", "scripts"), { recursive: true });
    await mkdir(path.join(tempDir, "skills", "compliance", "references"), { recursive: true });
    await mkdir(path.join(tempDir, "skills", "compliance", "templates"), { recursive: true });
    await mkdir(path.join(tempDir, "skills", "compliance", "assets"), { recursive: true });
    await mkdir(path.join(tempDir, "skills", "company", "kli", "compliance", "scripts"), { recursive: true });
    await mkdir(path.join(tempDir, "skills", "local", "agency", "compliance", "references"), { recursive: true });
    await mkdir(path.join(tempDir, "skills", "url", "github.com", "compliance", "templates"), { recursive: true });
    await mkdir(path.join(tempDir, "skills", "paperclipai", "paperclip", "paperclip", "scripts"), { recursive: true });
    await mkdir(path.join(tempDir, "skills", "scripts"), { recursive: true });
    await mkdir(path.join(tempDir, "vendor", "skills", "nested", "scripts"), { recursive: true });
    await mkdir(path.join(tempDir, "server"), { recursive: true });
    await writeFile(path.join(tempDir, "skills", "compliance", "SKILL.md"), "# Compliance\n");
    await writeFile(path.join(tempDir, "skills", "compliance", "scripts", "scan.mjs"), "export {};\n");
    await writeFile(path.join(tempDir, "skills", "compliance", "references", "rules.json"), "{}\n");
    await writeFile(path.join(tempDir, "skills", "compliance", "templates", "report.txt"), "Report\n");
    await writeFile(path.join(tempDir, "skills", "compliance", "assets", "schema.json"), "{}\n");
    await writeFile(path.join(tempDir, "skills", "company", "kli", "compliance", "scripts", "scan.mjs"), "export {};\n");
    await writeFile(path.join(tempDir, "skills", "local", "agency", "compliance", "references", "rules.json"), "{}\n");
    await writeFile(path.join(tempDir, "skills", "url", "github.com", "compliance", "templates", "report.txt"), "Report\n");
    await writeFile(path.join(tempDir, "skills", "paperclipai", "paperclip", "paperclip", "scripts", "upload.sh"), "exit 0\n");
    await writeFile(path.join(tempDir, "skills", "scripts", "scan.mjs"), "export {};\n");
    await writeFile(path.join(tempDir, "vendor", "skills", "nested", "scripts", "scan.mjs"), "export {};\n");
    await writeFile(path.join(tempDir, "server", "index.ts"), "export {};\n");

    const resolved = await resolveInlineSourceFromPath(tempDir);

    expect(resolved.files).toMatchObject({
      "skills/compliance/SKILL.md": "# Compliance\n",
      "skills/compliance/scripts/scan.mjs": "export {};\n",
      "skills/compliance/references/rules.json": "{}\n",
      "skills/compliance/templates/report.txt": "Report\n",
      "skills/compliance/assets/schema.json": "{}\n",
      "skills/company/kli/compliance/scripts/scan.mjs": "export {};\n",
      "skills/local/agency/compliance/references/rules.json": "{}\n",
      "skills/url/github.com/compliance/templates/report.txt": "Report\n",
      "skills/paperclipai/paperclip/paperclip/scripts/upload.sh": "exit 0\n",
    });
    expect(resolved.files).not.toHaveProperty("skills/scripts/scan.mjs");
    expect(resolved.files).not.toHaveProperty("vendor/skills/nested/scripts/scan.mjs");
    expect(resolved.files).not.toHaveProperty("server/index.ts");
  });
});
