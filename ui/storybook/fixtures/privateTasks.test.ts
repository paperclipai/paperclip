// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createPrivacyState, installPrivacyApi, privacyCompanyId, privacyTask, privacyGrant } from "./privateTasks";
describe("private task creation preview", () => {
  it.each([
    [{ title: "Open task" }, "open", null, null],
    [{ title: "Private task", visibility: "private" }, "private", "privacy-created", null],
    [{ title: "Private child", parentId: "privacy-root" }, "private", "privacy-root", "privacy-root"],
    [{ title: "Private project task", projectId: "project-private" }, "private", "privacy-created", null],
  ])("matches creation defaults for %j", async (data, visibility, privacyRootIssueId, privacyParentIssueId) => {
    const restore = installPrivacyApi(createPrivacyState({}));
    try {
      const response = await fetch(`/api/companies/${privacyCompanyId}/issues`, { method: "POST", body: JSON.stringify(data) });
      const task = await response.json();
      expect(task).toMatchObject({ visibility, privacyRootIssueId, privacyParentIssueId });
    } finally { restore(); }
  });
});

describe("task privacy moves in the preview", () => {
  it.each([
    [{ projectId: "project-private" }, "privacy-root", "privacy-root", null],
    [{ parentId: "privacy-child" }, "privacy-sibling", "privacy-root", "privacy-child"],
  ])("inherits privacy when moving an open task into %j", async (data, id, root, parent) => {
    const restore = installPrivacyApi(createPrivacyState({ visibility: "open" }));
    try {
      const response = await fetch(`/api/issues/${id}`, { method: "PATCH", body: JSON.stringify(data) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ visibility: "private", privacyRootIssueId: root, privacyParentIssueId: parent });
    } finally { restore(); }
  });
  it("inherits a parent's private project even if the parent is open", async () => {
    const state = createPrivacyState({ visibility: "open", taskProject: true });
    const restore = installPrivacyApi(state);
    try {
      const response = await fetch("/api/issues/privacy-sibling", { method: "PATCH", body: JSON.stringify({ parentId: "privacy-root" }) });
      expect(await response.json()).toMatchObject({ visibility: "private", privacyRootIssueId: "privacy-root", privacyParentIssueId: "privacy-root" });
    } finally { restore(); }
  });
  it("rejects publishing under a private project without mutating its scope", async () => {
    const state = createPrivacyState({ taskProject: true }); const restore = installPrivacyApi(state);
    try {
      const response = await fetch("/api/issues/privacy-root", { method: "PATCH", body: JSON.stringify({ visibility: "open" }) });
      expect(response.status).toBe(422);
      expect(state.tasks[0]).toMatchObject({ visibility: "private", projectId: "project-private" });
    } finally { restore(); }
  });
  it("leaves a personal project when making its task public", async () => {
    const restore = installPrivacyApi(createPrivacyState({ taskProject: true, personal: true }));
    try {
      const response = await fetch("/api/issues/privacy-root", { method: "PATCH", body: JSON.stringify({ visibility: "open" }) });
      expect(await response.json()).toMatchObject({ visibility: "open", projectId: null, project: null });
    } finally { restore(); }
  });
});


describe("preview descendants and effective access", () => {
  it.each([
    { projectId: "project-private" },
    { parentId: "private-peer" },
    { visibility: "private" },
  ])("protects the whole task subtree for %j", async (data) => {
    const state = createPrivacyState({ visibility: "open", grants: "empty" });
    for (const task of state.tasks) {
      task.visibility = "open";
      task.privacyRootIssueId = null;
      task.privacyParentIssueId = null;
    }
    // Include a provenance-only descendant, as well as ordinary child links.
    state.tasks[2]!.parentId = null;
    state.tasks[2]!.privacyParentIssueId = "privacy-child";
    state.tasks.push(privacyTask({ id: "private-peer", privacyRootIssueId: "private-peer" }));
    state.tasks.push(privacyTask({ id: "unrelated", visibility: "open", privacyRootIssueId: null }));
    const restore = installPrivacyApi(state);
    try {
      const response = await fetch("/api/issues/privacy-root", { method: "PATCH", body: JSON.stringify(data) });
      const root = await response.json();
      expect(response.status).toBe(200);
      for (const id of ["privacy-child", "privacy-grandchild", "privacy-sibling"]) {
        const child = await fetch(`/api/issues/${id}`).then(response => response.json());
        expect(child).toMatchObject({ visibility: "private", privacyRootIssueId: root.privacyRootIssueId });
        expect(child.privacyParentIssueId).not.toBeNull();
      }
      expect(state.tasks.find(task => task.id === "unrelated")?.visibility).toBe("open");
    } finally { restore(); }
  });
  it("drops former personal-project members after publishing and making the task private again", async () => {
    const restore = installPrivacyApi(createPrivacyState({ taskProject: true, personal: true, grants: "empty" }));
    try {
      const grants = () => fetch("/api/issues/privacy-root/access-grants").then(response => response.json());
      expect(await grants()).toContainEqual(expect.objectContaining({ subjectId: "user-product", source: "project" }));
      const published = await fetch("/api/issues/privacy-root", { method: "PATCH", body: JSON.stringify({ visibility: "open" }) }).then(response => response.json());
      expect(published).toMatchObject({ projectId: null, privacyRootIssueId: null });
      await fetch("/api/issues/privacy-root", { method: "PATCH", body: JSON.stringify({ visibility: "private" }) });
      expect(await grants()).not.toContainEqual(expect.objectContaining({ source: "project" }));
    } finally { restore(); }
  });
  it("removes inherited project membership after detaching from its parent", async () => {
    const restore = installPrivacyApi(createPrivacyState({ taskProject: true, grants: "empty" }));
    try {
      const grants = () => fetch("/api/issues/privacy-child/access-grants").then(response => response.json());
      expect(await grants()).toContainEqual(expect.objectContaining({ subjectId: "user-product", source: "project" }));
      await fetch("/api/issues/privacy-child", { method: "PATCH", body: JSON.stringify({ parentId: null }) });
      expect(await grants()).not.toContainEqual(expect.objectContaining({ source: "project" }));
    } finally { restore(); }
  });
  it("shows a child share only on that child and its descendants", async () => {
    const restore = installPrivacyApi(createPrivacyState({ grants: "empty" }));
    try {
      await fetch("/api/issues/privacy-child/access-grants", { method: "POST", body: JSON.stringify({ subjectType: "user", subjectId: "user-product" }) });
      for (const [id, expected] of [["privacy-root", false], ["privacy-child", true], ["privacy-grandchild", true], ["privacy-sibling", false]] as const) {
        const grants = await fetch(`/api/issues/${id}/access-grants`).then(response => response.json());
        expect(grants.some((grant: { subjectId: string }) => grant.subjectId === "user-product")).toBe(expected);
        if (id === "privacy-grandchild") expect(grants).toContainEqual(expect.objectContaining({ inherited: true, issueId: "privacy-child" }));
      }
    } finally { restore(); }
  });
  it("protects descendants when a project becomes private and keeps tasks private after opening it", async () => {
    const state = createPrivacyState({ visibility: "open", taskProject: true, grants: "empty" });
    state.projects[0]!.visibility = "open";
    for (const task of state.tasks) { task.visibility = "open"; task.privacyRootIssueId = null; }
    const restore = installPrivacyApi(state);
    try {
      await fetch("/api/projects/project-private", { method: "PATCH", body: JSON.stringify({ visibility: "private" }) });
      expect(state.tasks.every(task => task.visibility === "private" && task.privacyRootIssueId !== null)).toBe(true);
      await fetch("/api/projects/project-private", { method: "PATCH", body: JSON.stringify({ visibility: "open" }) });
      expect(state.tasks.every(task => task.visibility === "private")).toBe(true);
      const grants = await fetch("/api/issues/privacy-root/access-grants").then(response => response.json());
      expect(grants).not.toContainEqual(expect.objectContaining({ source: "project" }));
    } finally { restore(); }
  });
  it("keeps existing private descendants private when their parent is published", async () => {
    const state = createPrivacyState(); const restore = installPrivacyApi(state);
    try {
      await fetch("/api/issues/privacy-root", { method: "PATCH", body: JSON.stringify({ visibility: "open" }) });
      expect(state.tasks[0]).toMatchObject({ visibility: "open", privacyRootIssueId: null });
      expect(state.tasks.slice(1).every(task => task.visibility === "private")).toBe(true);
    } finally { restore(); }
  });
  it("does not revoke an ancestor grant through the child's endpoint", async () => {
    const state = createPrivacyState(); const restore = installPrivacyApi(state);
    try {
      const response = await fetch("/api/issues/privacy-child/access-grants/grant-morgan/revoke", { method: "POST", body: "{}" });
      expect(response.status).toBe(404);
      expect(state.grants.find(grant => grant.id === "grant-morgan")?.revokedAt).toBeNull();
    } finally { restore(); }
  });
});


describe("preview owner and saved assignment access", () => {
  it("keeps a child's own owner and assignment reasons after its parent becomes public", async () => {
    const state = createPrivacyState();
    state.tasks[1]!.responsibleUserId = "user-product";
    state.tasks[1]!.createdByUserId = "user-finance";
    const restore = installPrivacyApi(state);
    try {
      await fetch("/api/issues/privacy-root", { method: "PATCH", body: JSON.stringify({ visibility: "open" }) });
      const grants = await fetch("/api/issues/privacy-child/access-grants").then(response => response.json());
      for (const subjectId of ["user-product", "user-finance"]) expect(grants).toContainEqual(expect.objectContaining({ issueId: "privacy-child", subjectId, source: "owner", inherited: false }));
      expect(grants).toContainEqual(expect.objectContaining({ issueId: "privacy-child", subjectId: "agent-dedicated", source: "assignment", inherited: false }));
      expect(grants.every((grant: { issueId: string }) => grant.issueId === "privacy-child")).toBe(true);
    } finally { restore(); }
  });
  it("saves assignment access when a project becomes private and retains it after unassignment", async () => {
    const state = createPrivacyState({ visibility: "open", taskProject: true });
    state.projects[0]!.visibility = "open";
    for (const task of state.tasks) { task.visibility = "open"; task.privacyRootIssueId = null; }
    state.grants = [];
    const restore = installPrivacyApi(state);
    try {
      await fetch("/api/projects/project-private", { method: "PATCH", body: JSON.stringify({ visibility: "private" }) });
      await fetch("/api/issues/privacy-child", { method: "PATCH", body: JSON.stringify({ assigneeAgentId: null }) });
      await fetch("/api/projects/project-private", { method: "PATCH", body: JSON.stringify({ visibility: "open" }) });
      const grants = await fetch("/api/issues/privacy-child/access-grants").then(response => response.json());
      expect(grants).toContainEqual(expect.objectContaining({ issueId: "privacy-child", subjectId: "agent-dedicated", source: "assignment", inherited: false }));
      expect(grants).not.toContainEqual(expect.objectContaining({ source: "project" }));
    } finally { restore(); }
  });
  it("does not add an assignment grant beside an existing independent direct grant", async () => {
    const state = createPrivacyState({ grants: "empty" });
    state.grants.push(privacyGrant({ subjectType: "agent", subjectId: "agent-dedicated" }));
    const restore = installPrivacyApi(state);
    try {
      await fetch("/api/issues/privacy-root", { method: "PATCH", body: JSON.stringify({ assigneeAgentId: "agent-dedicated" }) });
      expect(state.grants.filter(grant => grant.issueId === "privacy-root" && grant.subjectId === "agent-dedicated")).toHaveLength(1);
    } finally { restore(); }
  });
  it.each([null, "agent-dedicated"])("uses the new task's actual assignment %s", async (assigneeAgentId) => {
    const restore = installPrivacyApi(createPrivacyState({ grants: "empty" }));
    try {
      await fetch(`/api/companies/${privacyCompanyId}/issues`, { method: "POST", body: JSON.stringify({ title: "Created private task", visibility: "private", assigneeAgentId }) });
      const grants = await fetch("/api/issues/privacy-created/access-grants").then(response => response.json());
      expect(grants).toContainEqual(expect.objectContaining({ issueId: "privacy-created", subjectId: "user-board", source: "owner", inherited: false }));
      expect(grants.filter((grant: { source: string }) => grant.source === "assignment")).toHaveLength(assigneeAgentId ? 1 : 0);
    } finally { restore(); }
  });
});


describe("revoked assignment access in previews", () => {
  it("does not restore a revoked assignment grant after unrelated edits", async () => {
    const state = createPrivacyState(); const restore = installPrivacyApi(state);
    try {
      await fetch("/api/issues/privacy-root/access-grants/grant-assignment/revoke", { method: "POST", body: "{}" });
      for (const data of [{ title: "Edited after revocation" }, { status: "done" }]) {
        await fetch("/api/issues/privacy-root", { method: "PATCH", body: JSON.stringify(data) });
      }
      const grants = await fetch("/api/issues/privacy-root/access-grants").then(response => response.json());
      expect(grants.filter((grant: { issueId: string; subjectId: string; revokedAt: string | null }) => grant.issueId === "privacy-root" && grant.subjectId === "agent-dedicated" && grant.revokedAt === null)).toHaveLength(0);
      expect(state.tasks[0]!.assigneeAgentId).toBe("agent-dedicated");
    } finally { restore(); }
  });
  it("saves a fresh assignment grant after an actual reassignment", async () => {
    const state = createPrivacyState(); const restore = installPrivacyApi(state);
    try {
      await fetch("/api/issues/privacy-root/access-grants/grant-assignment/revoke", { method: "POST", body: "{}" });
      await fetch("/api/issues/privacy-root", { method: "PATCH", body: JSON.stringify({ assigneeAgentId: null }) });
      await fetch("/api/issues/privacy-root", { method: "PATCH", body: JSON.stringify({ assigneeAgentId: "agent-dedicated" }) });
      const grants = await fetch("/api/issues/privacy-root/access-grants").then(response => response.json());
      const active = grants.filter((grant: { issueId: string; subjectId: string; revokedAt: string | null }) => grant.issueId === "privacy-root" && grant.subjectId === "agent-dedicated" && grant.revokedAt === null);
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ source: "assignment", inherited: false });
      expect(active[0].id).not.toBe("grant-assignment");
    } finally { restore(); }
  });
});
