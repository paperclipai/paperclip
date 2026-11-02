import { describe, expect, it } from "vitest";
import { isolationEntryMatches, isolationTaskMatches, restrictedCreateAllowed, restrictedForeignDenied, restrictedPositiveControl, workspacePairMatches, type IsolationTask } from "./company-access-contract.js";

const primary = { stackId: "qa-one", stackSlug: "one", companyId: "company-one", origin: "https://one.test.paperclip.app", displayName: "One", issuePrefix: "ONE" };
const secondary = { stackId: "qa-two", stackSlug: "two", companyId: "company-two", origin: "https://two.test.paperclip.app", displayName: "Two", issuePrefix: "TWO" };
const task: IsolationTask = { id: "task-two", companyId: secondary.companyId, title: "Foreign sentinel", description: "original", identifier: "TWO-1" };
const denied = { status: 403, task: null, contentLeaked: false };
describe("Cloud company isolation evidence", () => {
  it("accepts only an exact observed entry for the registered workspace", () => {
    const portal = "https://portal.example.test";
    for (const path of ["/stacks/two/enter", "/orgs/qa-two/enter", "/v1/stacks/two/entry-redirect", "/v1/stacks/qa-two/entry-redirect?by=id"])
      expect(isolationEntryMatches(portal + path, portal, secondary)).toBe(true);
    for (const href of [null, portal + "/stacks/one/enter", portal + "/v1/stacks/qa-two/entry-redirect", portal + "/v1/stacks/qa-two/entry-redirect?by=id&extra=1", "https://other.example.test/stacks/two/enter", portal + "/stacks/two/enter#fragment"])
      expect(isolationEntryMatches(href, portal, secondary)).toBe(false);
  });
  it("requires a unique new canonical task with real agent creation attribution", () => {
    const expected = { companyId: primary.companyId, title: "Owned create", description: "Fresh body", agentId: "agent-one" };
    const created = { ...expected, id: "new-task", identifier: "ONE-2", createdByAgentId: expected.agentId, createdByUserId: null,
      status: "backlog", assigneeAgentId: null, assigneeUserId: null };
    const input = { response: { status: 201, contentLeaked: false, task: created }, expected, before: [], after: [created], canonical: created };
    expect(restrictedCreateAllowed(input)).toBe(true);
    for (const patch of [{ createdByAgentId: "other" }, { createdByUserId: "human" }, { companyId: secondary.companyId }, { status: "in_progress" }, { assigneeAgentId: "agent-one" }, { description: "wrong" }])
      expect(restrictedCreateAllowed({ ...input, canonical: { ...created, ...patch } })).toBe(false);
    expect(restrictedCreateAllowed({ ...input, canonical: null })).toBe(false);
    expect(restrictedCreateAllowed({ ...input, before: [created] })).toBe(false);
    expect(restrictedCreateAllowed({ ...input, after: [created, created] })).toBe(false);
    expect(restrictedCreateAllowed({ ...input, response: { ...input.response, status: 403 } })).toBe(false);
  });
  it("requires two different real testing workspaces", () => {
    expect(workspacePairMatches(primary, secondary)).toBe(true);
    for (const patch of [{ stackId: primary.stackId }, { companyId: primary.companyId }, { origin: primary.origin }, { origin: "http://two.example.test" }, { origin: "https://two.example.test/path" }, { origin: "https://user:password@two.example.test" }, { issuePrefix: "" }]) expect(workspacePairMatches(primary, { ...secondary, ...patch })).toBe(false);
  });
  it("accepts only exact owner readback", () => {
    expect(isolationTaskMatches(task, task as IsolationTask & { description: string })).toBe(true);
    expect(isolationTaskMatches(undefined, task as IsolationTask & { description: string })).toBe(false);
    for (const patch of [{ id: "different" }, { companyId: primary.companyId }, { description: "changed" }]) expect(isolationTaskMatches({ ...task, ...patch }, task as IsolationTask & { description: string })).toBe(false);
  });
  it("requires an authenticated successful primary read and write control", () => {
    const expected = { id: "task-one", companyId: primary.companyId, description: "written by restricted agent" };
    expect(restrictedPositiveControl({ status: 200, contentLeaked: false, task: expected }, expected)).toBe(true);
    expect(restrictedPositiveControl({ status: 403, contentLeaked: false, task: null }, expected)).toBe(false);
    expect(restrictedPositiveControl({ status: 200, contentLeaked: false, task: { ...expected, companyId: secondary.companyId } }, expected)).toBe(false);
    expect(restrictedPositiveControl({ status: 200, contentLeaked: false, task: { ...expected, description: "old" } }, expected)).toBe(false);
  });
  it("requires both foreign denials and unchanged owner state", () => {
    expect(restrictedForeignDenied(denied, { status: 401, contentLeaked: false, task: null }, task, { ...task })).toBe(true);
    for (const status of [0, 200, 302, 404, 500]) expect(restrictedForeignDenied({ status, contentLeaked: false, task: null }, denied, task, task)).toBe(false);
    expect(restrictedForeignDenied(denied, { status: 200, contentLeaked: false, task }, task, task)).toBe(false);
    expect(restrictedForeignDenied(denied, denied, task, { ...task, description: "unauthorized change" })).toBe(false);
    expect(restrictedForeignDenied({ ...denied, contentLeaked: true }, denied, task, task)).toBe(false);
    expect(restrictedForeignDenied({ status: 403, contentLeaked: false, task }, denied, task, task)).toBe(false);
  });
});
