import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { CompanyPortabilityImport, CompanyPortabilityFileEntry } from "@paperclipai/shared";
import { companyPortabilityService } from "../services/company-portability.js";
import { documentService } from "../services/documents.js";
import { issueService } from "../services/issues.js";
import { ghFetch } from "../services/github-fetch.js";
import { retainTaskProviderOutputPolicy, taskForbidsProviderOutput } from "../services/task-provider-output-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../services/github-fetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/github-fetch.js")>(),
  ghFetch: vi.fn(),
}));

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const admissionError = "Task-content import is unavailable until native-only quarantine and derived-content confinement are qualified";
const include = { company: true, agents: false, projects: false, issues: true, skills: false };

describePostgres("company portability task-output admission", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-portability-output-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function fixture(restricted = true) {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Portable history", issuePrefix: `P${companyId.slice(0, 8)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Retained history", description: "Synthetic source description" });
    await retainTaskProviderOutputPolicy(db, { companyId, issueId, disposition: restricted ? "forbidden" : "ordinary" });
    await issueService(db).addComment(issueId, "Synthetic source comment", { userId: "local-board" });
    await documentService(db).upsertIssueDocument({ issueId, key: "report", format: "markdown", body: "Synthetic source document" });
    const exported = await companyPortabilityService(db).exportBundle(companyId, { include });
    expect(exported.manifest.issues).toHaveLength(1);
    const task = exported.manifest.issues[0]!;
    expect(task.description).toContain("Synthetic source description");
    expect(task.comments[0]?.body).toBe("Synthetic source comment");
    expect(task.documents).toHaveLength(1);
    expect(Object.values(exported.files).some(file => typeof file === "string" && file.includes("Synthetic source document"))).toBe(true);
    return { companyId, issueId, exported };
  }

  function githubSource(files: Record<string, CompanyPortabilityFileEntry>): CompanyPortabilityImport["source"] {
    vi.mocked(ghFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/git/trees/")) {
        return Response.json({ tree: Object.keys(files).map(path => ({ path, type: "blob" })) });
      }
      const filePath = new URL(url).pathname.split("/main/")[1];
      const body = filePath ? files[filePath] : undefined;
      if (typeof body !== "string") throw new Error(`Unexpected synthetic package request: ${url}`);
      return new Response(body);
    });
    return { type: "github", url: "https://github.com/synthetic/package/tree/main" };
  }

  async function assertRejectedWithoutWrites(input: CompanyPortabilityImport, mode: "board_full" | "agent_safe", sourceCompanyId: string, previewFirst = true) {
    const insert = vi.spyOn(db, "insert"), update = vi.spyOn(db, "update"), remove = vi.spyOn(db, "delete");
    const transaction = vi.spyOn(db, "transaction");
    const service = companyPortabilityService(db);
    const options = { mode, sourceCompanyId };
    if (previewFirst) {
      const preview = await service.previewImport(input, options);
      expect(preview.errors).toContainEqual(expect.stringContaining(admissionError));
      expect(preview.plan.issuePlans).toHaveLength(1);
    }
    await expect(service.importBundle(input, "local-board", options)).rejects.toMatchObject({
      status: 422, message: expect.stringContaining(admissionError),
    });
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  }

  for (const mode of ["board_full", "agent_safe"] as const) {
    for (const targetMode of ["new_company", "existing_company"] as const) {
      it.each([true, false])(`${mode} ${targetMode} rejects editable task history whose local source restriction is %s`, async restricted => {
        const f = await fixture(restricted);
        const targetId = randomUUID();
        await db.insert(companies).values({ id: targetId, name: "Unchanged destination", issuePrefix: `T${targetId.slice(0, 8)}` });
        const before = await db.select().from(companies).where(eq(companies.id, targetId));
        await assertRejectedWithoutWrites({
          source: { type: "inline", rootPath: f.exported.rootPath, files: f.exported.files }, include,
          target: targetMode === "new_company" ? { mode: targetMode, newCompanyName: "No imported company" } : { mode: targetMode, companyId: targetId },
          collisionStrategy: mode === "board_full" ? "replace" : "rename",
        }, mode, f.companyId);
        expect(await db.select().from(companies).where(eq(companies.id, targetId))).toEqual(before);
        expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.issueId })).toBe(restricted);
      });
    }
  }

  it.each(["inline", "github"] as const)("%s package cannot grant output through forged ordinary metadata", async sourceType => {
    const f = await fixture();
    const files = { ...f.exported.files };
    const taskPath = f.exported.manifest.issues[0]!.path;
    files[taskPath] = String(files[taskPath]).replace("---\n", "---\nproviderOutputDisposition: ordinary\nsourceTrust: promoted\n");
    expect(files[taskPath]).toContain("providerOutputDisposition: ordinary");
    const source = sourceType === "github" ? githubSource(files) : { type: "inline" as const, files };
    await assertRejectedWithoutWrites({ source, include, target: { mode: "new_company" } }, "board_full", f.companyId);
  });

  it("legacy TASK.md without the extension remains unknown rather than ordinary", async () => {
    const f = await fixture();
    const files = { ...f.exported.files };
    delete files[".paperclip.yaml"];
    await assertRejectedWithoutWrites({ source: { type: "inline", files }, include, target: { mode: "new_company" } }, "board_full", f.companyId);
  });

  it("selected-file import does not turn a retained task without its document into ordinary content", async () => {
    const f = await fixture();
    await assertRejectedWithoutWrites({
      source: { type: "inline", files: f.exported.files }, include, target: { mode: "new_company" },
      selectedFiles: ["COMPANY.md", ".paperclip.yaml", f.exported.manifest.issues[0]!.path],
    }, "board_full", f.companyId);
  });

  it("apply revalidates a source changed after a successful non-task preview", async () => {
    const f = await fixture();
    const source = githubSource({ "COMPANY.md": String(f.exported.files["COMPANY.md"]) });
    const input: CompanyPortabilityImport = { source, include, target: { mode: "new_company" } };
    expect((await companyPortabilityService(db).previewImport(input)).errors).toEqual([]);
    githubSource(f.exported.files);
    await assertRejectedWithoutWrites(input, "board_full", f.companyId, false);
  });

  it("does not materialize an agent or a recurring task before rejecting the task selection", async () => {
    const f = await fixture();
    const files: Record<string, CompanyPortabilityFileEntry> = {
      ...f.exported.files,
      "agents/worker/AGENTS.md": '---\nname: Worker\nkind: agent\n---\nSynthetic instructions.\n',
      "tasks/recurring/TASK.md": '---\nname: Recurring\nkind: task\nschedule: "0 0 * * *"\n---\nSynthetic routine.\n',
      ".paperclip.yaml": 'schemaVersion: 7\ntasks:\n  recurring:\n    recurring: true\n    status: todo\n    priority: medium\n',
    };
    delete files[f.exported.manifest.issues[0]!.path];
    await assertRejectedWithoutWrites({ source: { type: "inline", files }, include: { ...include, agents: true },
      target: { mode: "new_company" } }, "board_full", f.companyId);
  });

  it("explicit task deselection keeps the existing non-task import journey", async () => {
    const f = await fixture();
    const input: CompanyPortabilityImport = { source: { type: "inline", files: f.exported.files },
      include: { ...include, issues: false }, target: { mode: "new_company", newCompanyName: "Metadata only" } };
    const service = companyPortabilityService(db);
    const preview = await service.previewImport(input);
    expect(preview.errors).toEqual([]);
    expect(preview.plan.issuePlans).toHaveLength(0);
    const result = await service.importBundle(input, null);
    expect(result.company.name).toBe("Metadata only");
    expect(await db.select().from(issues).where(eq(issues.companyId, result.company.id))).toHaveLength(0);
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.issueId })).toBe(true);
  });

  it("a selected-file scope with no task keeps the non-task import path", async () => {
    const f = await fixture();
    const input: CompanyPortabilityImport = { source: { type: "inline", files: f.exported.files }, include,
      selectedFiles: ["COMPANY.md"], target: { mode: "new_company", newCompanyName: "Company file only" } };
    const preview = await companyPortabilityService(db).previewImport(input);
    expect(preview.include.issues).toBe(false);
    expect(preview.errors).toEqual([]);
    const result = await companyPortabilityService(db).importBundle(input, null);
    expect(await db.select().from(issues).where(eq(issues.companyId, result.company.id))).toHaveLength(0);
  });

  it("pausing automation and reconstructing the service cannot bypass rejection", async () => {
    const f = await fixture();
    const input: CompanyPortabilityImport = { source: { type: "inline", files: f.exported.files }, include,
      target: { mode: "new_company" } };
    await assertRejectedWithoutWrites(input, "board_full", f.companyId);
    await expect(companyPortabilityService(db).importBundle(input, null, { mode: "board_full", pauseAutomations: true }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining(admissionError) });
    await assertRejectedWithoutWrites(input, "board_full", f.companyId, false);
  });

  it("untouched ordinary local tasks retain normal content writes and output classification", async () => {
    const f = await fixture(false);
    await issueService(db).addComment(f.issueId, "Fresh ordinary content", { userId: "local-board" });
    expect((await issueService(db).listComments(f.issueId)).some(row => row.body === "Fresh ordinary content")).toBe(true);
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.issueId })).toBe(false);
    expect(await db.select().from(agents).where(eq(agents.companyId, f.companyId))).toHaveLength(0);
  });
});
