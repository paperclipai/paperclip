import { expect, test } from "@playwright/test";
import { copilotPendingPermissionCard } from "./copilot-permission-card.js";

test("selects the unanswered exact target while completed context remains visible", async ({ page }) => {
  await page.setContent('<div data-testid="task-chat-runtime-request">get_task_context — resolved</div><div data-testid="task-chat-runtime-request">Change file: pc-denied-A/target.txt<button>Deny</button><button>Allow once</button></div>');
  await expect(page.getByTestId("task-chat-runtime-request")).toHaveCount(2);
  const card = copilotPendingPermissionCard(page, "pc-denied-A/target.txt");
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
  await expect(copilotPendingPermissionCard(page, "get_task_context")).toHaveCount(0);
});

test("preserves duplicate detection and never borrows another target's control", async ({ page }) => {
  await page.setContent('<div data-testid="task-chat-runtime-request">Change file: expected.txt — resolved</div><div data-testid="task-chat-runtime-request">Change file: foreign.txt<button>Deny</button></div>');
  await expect(copilotPendingPermissionCard(page, "expected.txt")).toHaveCount(0);
  await page.setContent('<div data-testid="task-chat-runtime-request">Change file: expected.txt<button>Deny</button></div><div data-testid="task-chat-runtime-request">Change file: expected.txt<button>Deny</button></div>');
  await expect(copilotPendingPermissionCard(page, "expected.txt")).toHaveCount(2);
});

test("selects a new context decision without reusing an answered discovery card", async ({ page }) => {
  await page.setContent('<div data-testid="task-chat-runtime-request">search_api: get_task_context — resolved</div><div data-testid="task-chat-runtime-request">get_task_context<button>Deny</button><button>Allow once</button></div>');
  await expect(copilotPendingPermissionCard(page, "get_task_context")).toHaveCount(1);
  await expect(copilotPendingPermissionCard(page, "search_api")).toHaveCount(0);
});
