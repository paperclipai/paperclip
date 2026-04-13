import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClientContextMarkdown, composeRuntimeInstructionsFile } from "../services/heartbeat.js";

const createdFiles: string[] = [];

afterEach(async () => {
  await Promise.all(createdFiles.splice(0).map(async (filePath) => {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }));
});

describe("runtime instructions composition", () => {
  it("builds client context markdown with relationship details", () => {
    const markdown = buildClientContextMarkdown({
      clientId: "client-1",
      clientInstructionsFilePath: "/tmp/client-1/CLIENT.md",
      clientName: "Acme",
      clientEmail: "ops@acme.test",
      clientPhone: null,
      clientContactName: "Ana",
      clientNotes: "Prefer async updates",
      clientMetadata: { cnpj: "12.345.678/0001-00" },
      projectDescription: "Migration work",
      tags: ["react", "node"],
      projectNameOverride: "Acme Portal",
      projectMetadata: { legacyProjectType: "retainer" },
    });

    expect(markdown).toContain("## Client Context: Acme");
    expect(markdown).toContain("**CNPJ:** 12.345.678/0001-00");
    expect(markdown).toContain("**Relationship Notes:** Prefer async updates");
  });

  it("composes company, ordered client, and agent instructions into one file", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-instructions-test-"));
    const companyFile = path.join(tmpRoot, "COMPANY.md");
    const clientOneFile = path.join(tmpRoot, "client-a", "CLIENT.md");
    const clientTwoFile = path.join(tmpRoot, "client-b", "CLIENT.md");
    const agentFile = path.join(tmpRoot, "AGENTS.md");
    await fs.mkdir(path.dirname(clientOneFile), { recursive: true });
    await fs.mkdir(path.dirname(clientTwoFile), { recursive: true });
    await fs.writeFile(companyFile, "Company layer\n", "utf8");
    await fs.writeFile(clientOneFile, "Client A layer\n", "utf8");
    await fs.writeFile(clientTwoFile, "Client B layer\n", "utf8");
    await fs.writeFile(agentFile, "Agent layer\n", "utf8");

    const composedPath = await composeRuntimeInstructionsFile({
      runId: "run-1",
      companyInstructionsFilePath: companyFile,
      agentInstructionsFilePath: agentFile,
      clientLinks: [
        {
          clientId: "client-a",
          clientInstructionsFilePath: clientOneFile,
          clientName: "Client A",
          clientEmail: null,
          clientPhone: null,
          clientContactName: null,
          clientNotes: null,
          clientMetadata: null,
          projectDescription: null,
          tags: null,
          projectNameOverride: null,
          projectMetadata: null,
        },
        {
          clientId: "client-b",
          clientInstructionsFilePath: clientTwoFile,
          clientName: "Client B",
          clientEmail: null,
          clientPhone: null,
          clientContactName: null,
          clientNotes: null,
          clientMetadata: null,
          projectDescription: null,
          tags: null,
          projectNameOverride: null,
          projectMetadata: null,
        },
      ],
    });

    expect(composedPath).toBeTruthy();
    createdFiles.push(composedPath!);
    const contents = await fs.readFile(composedPath!, "utf8");
    expect(contents.indexOf("Company layer")).toBeLessThan(contents.indexOf("Client A layer"));
    expect(contents.indexOf("Client A layer")).toBeLessThan(contents.indexOf("Client B layer"));
    expect(contents.indexOf("Client B layer")).toBeLessThan(contents.indexOf("Agent layer"));
    expect(contents).toContain("## Client Context: Client A");
    expect(contents).toContain("Resolve any relative file references from");
  });
});
