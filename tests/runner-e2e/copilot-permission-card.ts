import type { Page } from "@playwright/test";

/** Answered context/discovery cards remain visible history. Match the current
 * operation and its decision control; API assertions independently require one
 * exact pending request and every POST is bound to its run/request/turn. */
export function copilotPendingPermissionCard(page: Page, operationOrTarget: string) {
  return page.getByTestId("task-chat-runtime-request")
    .filter({ visible: true, hasText: operationOrTarget })
    .filter({ has: page.getByRole("button", { name: "Deny", exact: true }) });
}
