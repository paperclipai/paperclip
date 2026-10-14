import { expect, type FrameLocator } from "@playwright/test";

// These expectations name shipped UI states, not captured visual baselines.
// Explicit fallback cases document where production has no separate error UI.
type State = {
  text?: string | RegExp;
  absent?: string | RegExp;
  skeleton?: true;
  selector?: string;
  emptyRootReason?: string;
  tokenHistory?: "active" | "expired" | "empty";
  editable?: true;
  defaultEnvironment?: true;
};
const failed: State = { text: "The request failed. Please try again." };
const denied: State = {
  text: "You do not have permission to perform this action.",
};
const skeleton: State = { skeleton: true };
const documentFallback: State = {
  text: "New document",
  absent: "Run the release checks.",
};
const environmentFallback: State = {
  defaultEnvironment: true,
  absent: "Release sandbox",
};
const states: Record<string, Record<string, State>> = {
  "feature-cli-authorization": {
    pending: { text: "Approve Paperclip CLI access" },
    loading: { text: "Loading CLI auth challenge..." },
    expired: { text: "CLI auth challenge expired" },
    unavailable: { text: "CLI auth challenge unavailable" },
  },
  "feature-membership": {
    members: { text: "Release reviewer" },
    loading: { text: "Loading organization access…" },
    empty: { text: "No user memberships found for this organization yet." },
    failed,
    "permission-denied": {
      text: "You do not have permission to manage organization members.",
    },
  },
  "feature-sign-in": {
    "signed-out": { text: "Sign in to Paperclip" },
    loading: { text: "Loading…" },
    "session-failed": {
      text: "Unable to check sign-in. Refresh and try again.",
    },
  },
  "feature-run-audit": {
    loading: { text: "Loading runs…" },
    empty: { text: "No runs yet." },
  },
  "feature-conference-room": {
    empty: { text: "Conference Room", editable: true },
  },
  "feature-catalog-review": {
    quarantined: { text: "Review 1 new action" },
    empty: { text: "No actions match “”. Clear the search to see them all." },
    refreshing: { text: "Review 1 new action", selector: ".animate-spin" },
    saving: { text: "Saving…" },
    "read-only": { text: "Actions", absent: "Review 1 new action" },
  },
  "feature-budget-resolution": {
    loading: skeleton,
    empty: { text: /No budget policies yet\./ },
    "load-failed": {
      text: "Budget data could not be loaded. Please try again shortly.",
    },
    "permission-denied": {
      text: "Budget data could not be loaded. Please try again shortly.",
    },
  },
  // Cases currently uses its empty presentation after a failed list query.
  "feature-case-browse": {
    loading: skeleton,
    empty: { text: "No cases yet" },
    failed: { text: "No cases yet" },
    "permission-denied": { text: "No cases yet" },
  },
  "feature-case-detail": {
    loading: skeleton,
    failed: { text: "Case not found." },
    "permission-denied": { text: "Case not found." },
    "arbitrary-fields": { text: "0.3.1" },
  },
  "feature-channel-attachments": {
    "no-files": { text: "Here is the release report.", absent: /Files ·/ },
    "multiple-files": { text: "Files · 2" },
    "missing-filename": { text: "attachment" },
  },
  "feature-company-import": { "choose-source": { text: "Import source" } },
  "feature-company-selection": {
    organizations: { text: "Archived Research" },
    loading: { text: "Loading organizations..." },
    empty: { text: "New Organization", absent: "Paperclip Storybook" },
    failed,
    "permission-denied": {
      text: "New Organization",
      absent: "Paperclip Storybook",
    },
  },
  "feature-document-revisions": {
    empty: documentFallback,
    loading: documentFallback,
    "read-failed": documentFallback,
    "permission-denied": documentFallback,
    edit: { text: "Run the release checks.", editable: true },
  },
  "feature-environment-images": {
    "no-image": { text: "Not configured" },
    "image-read-failed": { text: "Image metadata is unavailable." },
    "unsupported-provider": { text: "Unsupported provider" },
  },
  "feature-execution-environments": {
    loading: environmentFallback,
    empty: environmentFallback,
    failed: environmentFallback,
    "permission-denied": environmentFallback,
    "unsupported-provider": { text: "Isolated release checks" },
    "edit-configuration": {
      text: "Edit environment",
      selector: '[data-testid="environment-form-page"]',
    },
  },
  "feature-gateway-tokens": {
    "active-token": { tokenHistory: "active" },
    "no-tokens": { tokenHistory: "empty" },
    "expired-token": { tokenHistory: "expired" },
  },
  "feature-goal-alignment": {
    "empty-relationships": { text: "No sub-goals." },
    loading: skeleton,
    failed,
    "permission-denied": denied,
  },
  "feature-inbox-views": {
    mine: { text: "Create super-detailed storybooks for the project" },
    recent: { text: "Create super-detailed storybooks for the project" },
    unread: { text: "Create super-detailed storybooks for the project" },
    blocked: { text: "No work is stopped." },
    empty: { text: "Inbox zero." },
    loading: skeleton,
    failed: { text: "Inbox zero." },
    "permission-denied": { text: "Inbox zero." },
  },
  // Order reads are allowed to fall back to navigation; section collapse is local.
  "feature-sidebar-preferences": {
    "saved-order": {
      text: "Paperclip Storybook",
      selector: 'a[href="/PAP/dashboard"]',
    },
    "loading-order": {
      text: "Paperclip Storybook",
      selector: 'a[href="/PAP/dashboard"]',
    },
    "order-read-failed": {
      text: "Paperclip Storybook",
      selector: 'a[href="/PAP/dashboard"]',
    },
    "order-permission-denied": {
      text: "Paperclip Storybook",
      selector: 'a[href="/PAP/dashboard"]',
    },
  },
  "feature-onboarding-resume": {
    "malformed-draft": {
      text: "Create your first agent",
      selector: '[data-testid="onboarding-wizard"]',
    },
  },
  "feature-pipeline-learnings": {
    loading: skeleton,
    empty: { text: "No learnings yet." },
    failed: { text: "Could not load learnings." },
    "permission-denied": { text: "Could not load learnings." },
  },
  "feature-pipeline-board": {
    loading: skeleton,
    empty: { text: "0 total items", absent: "Ship the release notes" },
    failed: { text: "Pipeline not found." },
    "permission-denied": { text: "Pipeline not found." },
  },
  "feature-pipeline-review": {
    loading: skeleton,
    empty: { text: "Nothing needs you right now." },
    failed: { text: "Some items need attention. Try again in a moment." },
    "permission-denied": {
      text: "Some items need attention. Try again in a moment.",
    },
  },
  "feature-pipeline-stages": {
    loading: skeleton,
    failed,
    "permission-denied": denied,
  },
  "feature-plugin-configuration": {
    configured: {
      text: "Preview plugin",
      selector: 'input[value="Release preview"]',
    },
    loading: { text: "Loading plugin details..." },
    unavailable: { text: "Failed to load plugins." },
  },
  "feature-plugin-contributions": {
    loading: { text: "Loading…" },
    "missing-contribution": { text: "Preview plugin" },
    "discovery-failure": { text: "Loading…" },
  },
  "feature-plugin-management": {
    installed: { text: "Preview plugin" },
    empty: { text: "No plugins installed" },
    loading: { text: "Loading plugins..." },
    failed: { text: "Failed to load plugins." },
    "permission-denied": { text: "Failed to load plugins." },
  },
  "feature-routine-run-now": {
    overview: { text: "Review a release" },
    loading: skeleton,
    failed,
    "permission-denied": denied,
  },
  "feature-secret-proposal-review": {
    pending: { text: "dev/github/token" },
    loading: { text: "Loading proposals…" },
    empty: { text: "No pending proposals" },
    failed: { text: "Couldn’t load proposals. Try again." },
  },
  "feature-skill-test-runs": {
    "completed-test": { text: "succeeded" },
    queued: { text: "queued" },
    running: { text: "running" },
    "test-failed": { text: "failed" },
    empty: { text: "No test runs yet. Pick an agent and Run." },
    loading: { text: "Loading skill…" },
    "load-failed": { text: "Skill not found." },
    "permission-denied": { text: "Skill not found." },
  },
  "feature-status-card-states": {
    loading: { text: "Loading cards…" },
    empty: { text: "No status cards yet" },
    "load-failed": { text: "Could not load status cards" },
    "permission-denied": {
      text: "You do not have permission to perform this action.",
    },
    "setting-up": { text: "Setting up your card…" },
    "generation-failed": { text: "Last update failed" },
    "stale-summary": { text: "3 changes since last update" },
  },
  "feature-composer-draft-recovery": {
    restored: { text: "Review the release before publishing.", editable: true },
    empty: { editable: true, absent: "Review the release before publishing." },
    "uncertain-submission": {
      text: /We couldn’t confirm whether this comment was saved\./,
      selector: '[role="alert"]',
    },
  },
  "feature-durable-response-queue": {
    empty: {
      emptyRootReason:
        "The shipped queued-message component returns null for zero entries.",
    },
  },
};
export async function assertRenderState(frame: FrameLocator, id: string) {
  const [suite, variant] = id.split("--");
  const state = states[suite]?.[variant];
  if (!state)
    throw new Error(`Declare an explicit render expectation for ${id}`);
  expect(
    state,
    `Declare an explicit render expectation for ${id}`,
  ).toBeDefined();
  if (state.emptyRootReason) {
    await expect(frame.locator("#storybook-root")).toBeEmpty();
    return;
  }
  if (state.text)
    await expect(
      frame
        .getByText(state.text, { exact: typeof state.text === "string" })
        .first(),
    ).toBeVisible();
  if (state.absent)
    await expect(
      frame.getByText(state.absent, {
        exact: typeof state.absent === "string",
      }),
    ).toHaveCount(0);
  if (state.skeleton)
    await expect(frame.locator('[data-slot="skeleton"]').first()).toBeVisible();
  if (state.selector)
    await expect(frame.locator(state.selector).first()).toBeVisible();
  if (state.defaultEnvironment) {
    const select = frame.getByRole("combobox", { name: "Default environment" });
    await expect(select).toBeVisible();
    await expect(select).toHaveValue("");
    await expect(
      select.getByRole("option", { name: "Local", exact: true }),
    ).toBeAttached();
  }
  if (state.editable)
    await expect(frame.getByRole("textbox").first()).toBeVisible();
  if (state.tokenHistory) {
    await frame.getByRole("button", { name: /Token history/ }).click();
    if (state.tokenHistory === "empty")
      await expect(
        frame.getByText("No tokens have been issued for this gateway."),
      ).toBeVisible();
    else {
      await expect(
        frame.getByText("Preview client", { exact: true }).first(),
      ).toBeVisible();
      if (state.tokenHistory === "expired")
        await expect(
          frame.getByText("Expired", { exact: true }).first(),
        ).toBeVisible();
    }
  }
}
