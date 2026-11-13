import { expect, test } from "@playwright/test";
import { kimiPendingWritePermissionCard } from "./kimi-permission-card.js";
import type { KimiLifecyclePending } from "./kimi-lifecycle-evidence.js";

const pending: KimiLifecyclePending = {
  schema: "paperclip.e2e.kimi-native-write-pending.v1",
  scope: { companyId: "synthetic-company", issueId: "synthetic-issue", runId: "synthetic-run", target: "denied/expected.txt" },
  requestId: "native-write-request", toolCallId: "0:native-write", executionId: "0:native-write", itemId: "native-item", turnId: "native-turn",
  normalizedSessionId: "native-session", sourceInstanceId: "native-runner", requestSourceSeq: 9, startedSourceSeq: 7,
  requestRowSha256: `sha256:${"a".repeat(64)}`, startedRowSha256: `sha256:${"b".repeat(64)}`, observedMonotonicNs: "1",
};
const card = (prompt: string, status: string, controls = "") => `<article data-testid="task-chat-runtime-request"><header><strong>Runtime permission</strong><span>${status}</span></header><p>${prompt}</p>${controls}</article>`;
const decisions = '<button>Deny</button><button>Allow once</button>';
const history = card("mcp__paperclip__get_task_context", "resolved");
const write = () => card(`Change file: ${pending.scope.target}`, "pending", decisions);

test("selects the exact pending Write while resolved context remains visible, then follows the same terminal card", async ({ page }) => {
  await page.setContent(history + write());
  await expect(page.getByTestId("task-chat-runtime-request")).toHaveCount(2);
  const selected = await kimiPendingWritePermissionCard({ page, pending, readPending: async () => structuredClone(pending) });
  await expect(selected).toHaveCount(1);
  await expect(page.getByText("mcp__paperclip__get_task_context", { exact: true })).toBeVisible();
  for (const status of ["cancelled", "expired"]) {
    await page.setContent(history + card(`Change file: ${pending.scope.target}`, status));
    await expect(selected).toHaveCount(1);
    await expect(selected.getByText(status, { exact: true })).toBeVisible();
    await expect(selected.getByRole("button")).toHaveCount(0);
    await expect(page.getByText("mcp__paperclip__get_task_context", { exact: true })).toBeVisible();
  }
});

test("rejects a foreign target and never borrows its decisions for a closed matching card", async ({ page }) => {
  await page.setContent(history + card(`Change file: ${pending.scope.target}`, "resolved") + card("Change file: foreign.txt", "pending", decisions));
  await expect(kimiPendingWritePermissionCard({ page, pending, readPending: async () => structuredClone(pending) })).rejects.toThrow();
});

test("rejects a target that only contains the expected filename", async ({ page }) => {
  await page.setContent(history + card(`Change file: ${pending.scope.target}.foreign`, "pending", decisions));
  await expect(kimiPendingWritePermissionCard({ page, pending, readPending: async () => structuredClone(pending) })).rejects.toThrow();
});

test("rejects duplicate matching pending cards", async ({ page }) => {
  await page.setContent(history + write() + write());
  await expect(kimiPendingWritePermissionCard({ page, pending, readPending: async () => structuredClone(pending) })).rejects.toThrow();
});

for (const key of ["requestId", "toolCallId", "turnId", "sourceInstanceId"] as const) {
  test(`rejects a changed native ${key} before locating the card`, async ({ page }) => {
    await page.setContent(history + write());
    await expect(kimiPendingWritePermissionCard({ page, pending, readPending: async () => ({ ...pending, [key]: "foreign" }) })).rejects.toThrow("pending callback changed");
  });
}

test("rechecks the native request after the UI lookup", async ({ page }) => {
  await page.setContent(history + write());
  let reads = 0;
  await expect(kimiPendingWritePermissionCard({ page, pending, readPending: async () => ++reads === 1 ? structuredClone(pending) : { ...pending, requestId: "replacement" } })).rejects.toThrow("pending callback changed");
  expect(reads).toBe(2);
});

test("rejects disabled pending decisions", async ({ page }) => {
  await page.setContent(history + card(`Change file: ${pending.scope.target}`, "pending", '<button disabled>Deny</button><button disabled>Allow once</button>'));
  await expect(kimiPendingWritePermissionCard({ page, pending, readPending: async () => structuredClone(pending) })).rejects.toThrow();
});
