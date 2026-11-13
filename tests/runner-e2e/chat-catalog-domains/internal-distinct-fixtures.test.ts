import { expect, it } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { verifyDistinctTaskFixtures } from "./internal-distinct-fixtures.js";
const originals = () => [{ id: "launch-task", companyId: "company", title: "Landing page", projectId: "launch", status: "backlog" },
  { id: "experiment-task", companyId: "company", title: "Landing page", projectId: "experiments", status: "backlog" }];
function context(rows = originals()) { return { input: { api: { get: async (path: string) => rows.find(row => path.endsWith(`/${row.id}`)) }, fixtures: { company: { id: "company" } }, evidence: async () => undefined } } as unknown as ChatCatalogContext; }
it("accepts genuinely distinct saved same-title tasks in the declared projects", async () => expect(await verifyDistinctTaskFixtures(context(), originals())).toEqual(originals()));
it("rejects public-create title reuse before sending the canonical query", async () => { const rows = originals(); rows[1] = rows[0]!; await expect(verifyDistinctTaskFixtures(context(rows), rows)).rejects.toThrow(/aliased/); });
it("rejects a saved task in the wrong project or company", async () => { const rows = originals(); rows[1]!.projectId = "launch"; await expect(verifyDistinctTaskFixtures(context(rows), originals())).rejects.toThrow(/project/); const foreign = originals(); foreign[1]!.companyId = "foreign"; await expect(verifyDistinctTaskFixtures(context(foreign), originals())).rejects.toThrow(/identity/); });
