import { describe, expect, it } from "vitest";
import {
  armIssueDetailInboxQuickArchive,
  createIssueDetailLocationState,
  createIssueDetailPath,
  hasLegacyIssueDetailQuery,
  readIssueDetailHeaderSeed,
  readIssueDetailLocationState,
  readIssueDetailBreadcrumb,
  rememberIssueDetailLocationState,
  shouldArmIssueDetailInboxQuickArchive,
  withIssueDetailHeaderSeed,
} from "./issueDetailBreadcrumb";
import type { Issue } from "@paperclipai/shared";

const sessionStorageMock = (() => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    clear: () => {
      store.clear();
    },
  };
})();

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { sessionStorage: sessionStorageMock },
});

describe("issueDetailBreadcrumb", () => {
  function createIssue(overrides: Partial<Issue> = {}): Issue {
    return {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: null,
      goalId: null,
      parentId: null,
      title: "Prefilled issue title",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      createdByAgentId: null,
      createdByUserId: null,
      issueNumber: 42,
      identifier: "PAP-42",
      originKind: "manual",
      originId: null,
      originRunId: null,
      requestDepth: 0,
      billingCode: null,
      assigneeAdapterOverrides: null,
      executionPolicy: null,
      executionState: null,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      hiddenAt: null,
      project: {
        id: "project-1",
        companyId: "company-1",
        urlKey: "paperclip-app",
        goalId: null,
        goalIds: [],
        goals: [],
        name: "Paperclip App",
        description: null,
        status: "in_progress",
        leadAgentId: null,
        targetDate: null,
        color: null,
        env: null,
        pauseReason: null,
        pausedAt: null,
        executionWorkspacePolicy: null,
        codebase: {
          workspaceId: null,
          repoUrl: null,
          repoRef: null,
          defaultRef: null,
          repoName: null,
          localFolder: null,
          managedFolder: "/tmp/paperclip-app",
          effectiveLocalFolder: "/tmp/paperclip-app",
          origin: "local_folder",
        },
        workspaces: [],
        primaryWorkspace: null,
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      goal: null,
      currentExecutionWorkspace: null,
      workProducts: [],
      mentionedProjects: [],
      myLastTouchAt: null,
      lastExternalCommentAt: null,
      lastActivityAt: null,
      isUnreadForMe: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it("returns clean issue detail paths", () => {
    expect(createIssueDetailPath("PAP-465")).toBe("/issues/PAP-465");
  });

  it("prefers the full breadcrumb from route state", () => {
    const state = createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox");

    expect(readIssueDetailBreadcrumb("PAP-465", state, "?from=issues")).toEqual({
      label: "Inbox",
      href: "/inbox/mine",
    });
  });

  it("falls back to the source query param when route state is unavailable", () => {
    expect(readIssueDetailBreadcrumb("PAP-465", null, "?from=inbox")).toEqual({
      label: "Inbox",
      href: "/inbox",
    });
  });

  it("can detect legacy query-based breadcrumb links", () => {
    expect(hasLegacyIssueDetailQuery("?from=inbox&fromHref=%2Finbox%2Fmine")).toBe(true);
    expect(hasLegacyIssueDetailQuery("?q=test")).toBe(false);
  });

  it("restores the exact breadcrumb href from the query fallback", () => {
    expect(
      readIssueDetailBreadcrumb("PAP-465", null, "?from=inbox&fromHref=%2FPAP%2Finbox%2Funread"),
    ).toEqual({
      label: "Inbox",
      href: "/PAP/inbox/unread",
    });
  });

  it("reads hidden breadcrumb context from session storage when route state is unavailable", () => {
    const state = createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox");
    sessionStorageMock.clear();
    rememberIssueDetailLocationState("PAP-465", state);

    expect(
      readIssueDetailLocationState("PAP-465", null),
    ).toEqual({
      issueDetailBreadcrumb: { label: "Inbox", href: "/inbox/mine" },
      issueDetailSource: "inbox",
      issueDetailInboxQuickArchiveArmed: false,
    });
  });

  it("attaches and reads issue header seed data from route state", () => {
    const seededState = withIssueDetailHeaderSeed(
      createIssueDetailLocationState("Issues", "/issues", "issues"),
      createIssue(),
    );

    expect(readIssueDetailHeaderSeed(seededState)).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      identifier: "PAP-42",
      title: "Prefilled issue title",
      status: "todo",
      priority: "medium",
      projectId: "project-1",
      projectName: "Paperclip App",
      originKind: "manual",
      originId: null,
    });
  });

  it("persists issue header seed data when breadcrumb state is remembered", () => {
    const seededState = withIssueDetailHeaderSeed(
      createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox"),
      createIssue(),
    );

    sessionStorageMock.clear();
    rememberIssueDetailLocationState("PAP-42", seededState);

    const restoredState = readIssueDetailLocationState("PAP-42", null);
    expect(readIssueDetailHeaderSeed(restoredState)).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      identifier: "PAP-42",
      title: "Prefilled issue title",
      status: "todo",
      priority: "medium",
      projectId: "project-1",
      projectName: "Paperclip App",
      originKind: "manual",
      originId: null,
    });
  });

  it("can arm quick archive only for explicit inbox keyboard entry state", () => {
    const state = createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox");

    expect(shouldArmIssueDetailInboxQuickArchive(state)).toBe(false);
    expect(shouldArmIssueDetailInboxQuickArchive(armIssueDetailInboxQuickArchive(state))).toBe(true);
  });
});
