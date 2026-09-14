import { createRequire } from "node:module";

import { expect, test, type Page } from "@playwright/test";

import { CAPABILITY_UI_SHOT_SLUGS } from "../../src/issue-thread/fixtures";
import type {
  CapabilityIssueThreadSnapshot,
  CapabilityThreadItem,
} from "../../src/issue-thread/types";

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

function route(slug: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({ shot: slug, capture: "1", ...params });
  return `/#/issue/hb-baseline?${query.toString()}`;
}

/** Every route settles on a data attribute, never on a timeout (§10.1). */
async function open(page: Page, slug: string, params: Record<string, string> = {}) {
  await page.goto(route(slug, params));
  await expect(page.locator('[data-thread-state="settled"]')).toBeVisible();
}

interface AxeViolation {
  id: string;
  impact: string | null;
  nodes: unknown[];
}

async function seriousAxeViolations(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: AxeViolation[] }> } }).axe;
    const results = await axe.run(document, {
      resultTypes: ["violations"],
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? null,
      nodes: violation.nodes.length,
    }));
  });
  return (violations as unknown as AxeViolation[]).filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
}

test.describe("Capability issue thread", () => {
  test("loads the bundled sans and mono faces before the thread settles", async ({ page }) => {
    await open(page, "thread-baseline");

    const probe = await page.evaluate(async () => {
      const normalizeFamily = (family: string) => family.trim().replace(/^['"]|['"]$/g, "");
      const styles = getComputedStyle(document.documentElement);
      const sansFamily = normalizeFamily(styles.getPropertyValue("--pit-font-sans").split(",")[0]);
      const monoFamily = normalizeFamily(styles.getPropertyValue("--pit-font-mono").split(",")[0]);
      const symbolFamily = normalizeFamily(styles.getPropertyValue("--pit-font-symbols"));
      await document.fonts.load(`400 16px "${symbolFamily}"`, "◐⏳\uFE0E");
      const statuses = (family: string) =>
        [...document.fonts]
          .filter((face) => normalizeFamily(face.family) === family)
          .map((face) => face.status);

      return {
        sansFamily,
        monoFamily,
        symbolFamily,
        sansStatuses: statuses(sansFamily),
        monoStatuses: statuses(monoFamily),
        symbolStatuses: statuses(symbolFamily),
        sansWeightsLoaded: [400, 500, 600, 700].every((weight) =>
          document.fonts.check(`${weight} 16px "${sansFamily}"`, "Paperclip"),
        ),
        monoWeightsLoaded: [400, 700].every((weight) =>
          document.fonts.check(`${weight} 16px "${monoFamily}"`, "TASK-17003"),
        ),
        symbolsLoaded: document.fonts.check(`400 16px "${symbolFamily}"`, "◐⏳\uFE0E"),
      };
    });

    expect(probe).toEqual({
      sansFamily: "Paperclip Issue Thread Inter",
      monoFamily: "Paperclip Issue Thread DejaVu Sans Mono",
      symbolFamily: "Paperclip Issue Thread Symbols",
      sansStatuses: ["loaded"],
      monoStatuses: ["loaded", "loaded"],
      symbolStatuses: ["loaded", "loaded"],
      sansWeightsLoaded: true,
      monoWeightsLoaded: true,
      symbolsLoaded: true,
    });
  });

  test("baseline thread renders identity, turns, and the §3 item types", async ({ page }) => {
    await open(page, "thread-baseline");

    await expect(page.locator('[data-session-mode="fake"]').first()).toBeVisible();
    const chips = page.getByTestId("identity-chips");
    await expect(chips.getByTestId("agent-chip")).toHaveText("Fake agent");
    await expect(chips.getByTestId("runner-chip")).toContainText("In-process runner");
    await expect(chips.getByTestId("control-plane-chip")).toHaveText("Mock Paperclip");

    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator('[data-turn-id]')).toHaveCount(3);
    for (const kind of ["user_message", "agent_message", "durable_comment", "tool_activity"]) {
      await expect(page.locator(`[data-thread-item="${kind}"]`).first()).toBeVisible();
    }
    await expect(page.locator('[data-composer-state="ready"]')).toHaveCount(1);
  });

  test("a durable progress comment is visually distinct from model prose", async ({ page }) => {
    await open(page, "thread-baseline");
    await expect(
      page.locator('[data-thread-item="durable_comment"]').getByText("Recorded to mock thread"),
    ).toBeVisible();
    await expect(
      page.locator('[data-thread-item="agent_message"]').first().getByText("Recorded to mock thread"),
    ).toHaveCount(0);
  });

  test("tool strips are collapsed disclosures that deep-link into Evidence", async ({ page }) => {
    await open(page, "thread-baseline");
    const strip = page.locator('[data-tool-strip="get_task_context"]').first();
    await expect(strip).not.toHaveAttribute("open", "");
    await strip.locator("summary").click();
    await expect(strip).toHaveAttribute("open", "");

    await page.getByRole("button", { name: "View in Evidence" }).first().click();
    const panel = page.getByTestId("evidence-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-record-id="call-1"][data-highlighted="true"]')).toBeVisible();
  });

  test("a pending question card resolves inline and releases the composer", async ({ page }) => {
    await open(page, "interaction-question-pending");

    await expect(page.locator('[data-composer-state="waiting"]')).toBeVisible();
    const card = page.locator('[data-interaction-id="ix-questions-01"]');
    await expect(card).toHaveAttribute("data-interaction-state", "pending");
    await expect(card.getByTestId("interaction-state-chip")).toContainText("Waiting for you");

    // The submit is rejected until every required question is answered.
    await card.getByRole("button", { name: "Submit answers" }).click();
    await expect(card.getByRole("alert")).toContainText("required");

    await card.getByRole("radio", { name: "Yes — runner owns it" }).check();
    await card.getByRole("combobox").selectOption("hb-baseline");
    await card.getByRole("button", { name: "Submit answers" }).click();

    await expect(card).toHaveAttribute("data-interaction-state", "answered");
    await expect(card.getByTestId("interaction-state-chip")).toContainText("Answered");
    await expect(page.locator('[data-composer-state="ready"]').first()).toBeVisible();
  });

  test("a revision-bound confirmation names its target and requires a reject reason", async ({
    page,
  }) => {
    await open(page, "interaction-confirmation-pending");
    const card = page.locator('[data-interaction-id="ix-confirmation-plan-01"]');
    await expect(card.getByTestId("interaction-target")).toHaveText("plan · r4");

    await card.getByRole("button", { name: "Request changes" }).click();
    await expect(card.getByRole("alert")).toContainText("reason is required");
    await expect(card).toHaveAttribute("data-interaction-state", "pending");

    await card.getByRole("textbox").fill("Split the acceptance section first.");
    await card.getByRole("button", { name: "Request changes" }).click();
    await expect(card).toHaveAttribute("data-interaction-state", "rejected");
    await expect(card).toContainText("Split the acceptance section first.");
  });

  test("resolved, rejected, stale, and superseded cards stay distinct in history", async ({
    page,
  }) => {
    await open(page, "interaction-resolved-mixed");
    for (const state of ["answered", "accepted", "rejected", "stale_target", "superseded_by_comment"]) {
      await expect(
        page.locator(`[data-interaction-state="${state}"]`),
        `missing ${state}`,
      ).toHaveCount(1);
    }
    // Expired treatments keep their controls removed but stay reachable.
    await expect(
      page.locator('[data-interaction-state="stale_target"] button', { hasText: "Approve" }),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-interaction-state="stale_target"]').getByRole("button", {
        name: "View request evidence",
      }),
    ).toBeVisible();
  });

  test("the deliverable strip and card report one size in one unit", async ({ page }) => {
    await open(page, "deliverable-registered");
    const card = page.locator('[data-thread-item="deliverable"]');
    await expect(card).toContainText("18.0 kB");
    await expect(
      page.locator('[data-tool-strip="register_deliverable"]'),
    ).toContainText("18.0 kB");
  });

  test("a denial quotes the authorization record verbatim and badges Evidence", async ({
    page,
  }) => {
    await open(page, "denial-optional-tool");
    await expect(page.getByTestId("denial-reason")).toHaveText(
      "denied: missing grant su:read_or_write",
    );
    await expect(page.getByTestId("evidence-toggle")).toContainText("(1)");

    await page.locator('[data-thread-item="denial"]').getByRole("button", { name: "View in Evidence" }).click();
    const record = page.getByTestId("evidence-panel").locator('[data-record-id="authz-deny-1"]');
    await expect(record).toHaveAttribute("data-allowed", "false");
    await expect(record).toContainText("denied: missing grant su:read_or_write");
  });

  test("Evidence exposes eight sections, a turn selector, and the withheld control-plane list", async ({
    page,
  }) => {
    await open(page, "debug-panel-open", { panel: "authorization" });
    const panel = page.getByTestId("evidence-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-evidence-section]")).toHaveCount(8);
    await expect(panel.locator("#evidence-turn-selector")).toBeVisible();

    // The Tools section is open by default; assert its groups directly.
    await expect(
      panel.locator('[data-evidence-section="tools"] button').first(),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByText("Control plane (not exposed to the agent)")).toBeVisible();
    await expect(
      panel.locator('[data-disposition="control_plane_owned"]', { hasText: "create_task" }),
    ).toBeVisible();
    await expect(panel.getByText("Agent tool — always")).toBeVisible();
    await expect(panel.getByText("Agent tool — granted")).toBeVisible();

  });

  test("tool exposure groups are deduplicated, foldable, and open catalog details", async ({ page }) => {
    await open(page, "debug-panel-open", { panel: "tools" });
    const panel = page.getByTestId("evidence-panel");
    const always = panel.getByRole("button", { name: /Agent tool — always/ });
    await expect(always).toHaveCount(1);
    await always.click();
    await expect(panel.getByRole("button", { name: /get_task_context/ })).toHaveCount(0);
    await always.click();
    await panel.getByRole("button", { name: /get_task_context/ }).click();
    const dialog = page.getByRole("dialog", { name: "Get active task context" });
    await expect(dialog).toContainText("Read the active mock task, actor, wake, ancestors, budget, and interaction results.");
    await expect(dialog).toContainText("Input schema");
    await dialog.getByRole("button", { name: "Close tool details" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("Evidence records link back to their thread anchor", async ({ page }) => {
    await open(page, "debug-panel-open", { panel: "calls" });
    const panel = page.getByTestId("evidence-panel");
    await panel.locator('[data-record-id="call-1"]').getByRole("button", { name: "Show in thread" }).click();
    await expect(page.locator('[data-tool-strip="get_task_context"]')).toBeInViewport();
  });

  test("the splitter resizes the panel from the keyboard", async ({ page }) => {
    await open(page, "debug-panel-open", { panel: "tools" });
    const splitter = page.getByRole("separator", { name: "Resize the evidence panel" });
    const before = await splitter.getAttribute("aria-valuenow");
    await splitter.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(splitter).not.toHaveAttribute("aria-valuenow", before ?? "");
  });

  test("the splitter drag makes the DevTools panel wider", async ({ page }) => {
    await open(page, "debug-panel-open", { panel: "tools" });
    const splitter = page.getByRole("separator", { name: "Resize the evidence panel" });
    const panel = page.getByTestId("evidence-panel");
    const handle = await splitter.boundingBox();
    const before = await panel.boundingBox();
    expect(handle).not.toBeNull();
    expect(before).not.toBeNull();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle!.x - 140, handle!.y + handle!.height / 2, { steps: 5 });
    await page.mouse.up();
    const after = await panel.boundingBox();
    expect(after!.width).toBeGreaterThan(before!.width + 100);
  });

  test("reset is confirmed, escapable, and clears the thread", async ({ page }) => {
    await open(page, "disposition-terminal");
    await page.getByTestId("reset-button").click();
    const dialog = page.getByTestId("reset-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("The transcript will be lost.");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.getByTestId("reset-button").click();
    await page
      .getByTestId("reset-dialog")
      .getByRole("button", { name: "Reset scenario", exact: true })
      .click();
    await expect(page.locator('[data-thread-item="disposition"]')).toHaveCount(0);
    await expect(page.locator('[data-composer-state="ready"]').first()).toBeVisible();
  });

  test("stop keeps the partial turn and marks it", async ({ page }) => {
    await open(page, "turn-streaming");
    await expect(page.locator('[data-composer-state="streaming"]')).toBeVisible();
    await expect(page.getByTestId("composer-stop")).toBeVisible();
    await expect(page.locator('[data-composer-state="streaming"] textarea')).toBeEnabled();

    await page.getByTestId("composer-stop").click();
    await expect(page.getByTestId("stopped-marker")).toBeVisible();
    await expect(page.locator('[data-thread-item="agent_message"]').last()).toContainText(
      "Two dependent tasks are still open",
    );
  });

  test("reconnect pins an amber banner and disables the composer", async ({ page }) => {
    await open(page, "reconnect-banner");
    await expect(page.getByTestId("reconnect-banner")).toContainText("attempt 2");
    await expect(page.locator('[data-composer-state="reconnecting"]')).toBeVisible();
    await expect(page.locator('[data-composer-state="reconnecting"] textarea')).toBeDisabled();

    await page.getByRole("button", { name: "Retry now" }).click();
    await expect(page.getByText("Reconnected")).toBeVisible();
  });

  test("replay is read-only and labelled as fake-derived", async ({ page }) => {
    await open(page, "replay-mode");
    await expect(page.getByTestId("agent-chip")).toContainText("Replay · fake source");
    await expect(page.getByTestId("composer-reason")).toHaveText("Replay is read-only");
    await expect(page.getByTestId("replay-strip")).toContainText("Replay 12/18");
    await expect(page.locator('[data-composer-state="disabled"] textarea')).toBeDisabled();
  });

  test("the replay strip steps, advances, and plays through to the end", async ({ page }) => {
    await open(page, "replay-mode");
    const strip = page.getByTestId("replay-strip");
    const progress = page.getByRole("progressbar", { name: "Replay progress" });

    await page.getByTestId("replay-step-back").click();
    await expect(strip).toContainText("Replay 11/18");
    await expect(progress).toHaveAttribute("aria-valuenow", "11");

    await page.getByTestId("replay-next-turn").click();
    await expect(strip).toContainText("Replay 12/18");

    // Play-all runs the recording out and parks itself at the last ordinal
    // instead of leaving the operator to click Next turn eighteen times (§6).
    const playAll = page.getByTestId("replay-play-all");
    await playAll.click();
    await expect(playAll).toHaveAttribute("aria-pressed", "true");
    await expect(strip).toContainText("Replay 18/18", { timeout: 15_000 });
    await expect(playAll).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("replay-next-turn")).toBeDisabled();
  });

  test("a terminal disposition keeps the composer available", async ({ page }) => {
    await open(page, "disposition-terminal");
    await expect(page.locator('[data-thread-item="disposition"]')).toContainText("Done");
    await expect(page.locator("#composer-input")).toBeEnabled();
    await expect(page.getByText("This task is done. You can still continue the conversation.")).toBeVisible();
  });

  test("composer drafts survive a refresh", async ({ page }) => {
    await open(page, "thread-baseline");
    await page.locator("#composer-input").fill("Draft that must survive F5.");
    await page.reload();
    await expect(page.locator('[data-thread-state="settled"]')).toBeVisible();
    await expect(page.locator("#composer-input")).toHaveValue("Draft that must survive F5.");
  });

  test("mobile keeps the thread usable with no horizontal page scroll", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await open(page, "turn-streaming");

    const overflow = await page.evaluate(() => {
      const element = document.scrollingElement as HTMLElement;
      return element.scrollWidth - element.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);

    // Stop stays outside the overflow menu while a turn is active (§2.2).
    await expect(page.getByTestId("stop-button")).toBeVisible();
    await expect(page.getByTestId("stop-button")).toBeEnabled();
    await expect(page.getByTestId("overflow-menu")).toHaveCount(0);

    await page.getByTestId("segment-evidence").click();
    await expect(page.getByTestId("evidence-panel")).toBeVisible();
    await expect(page.getByTestId("evidence-panel")).toHaveAttribute("data-layout", "segment");
  });

  test("mobile surfaces the denial count on the Evidence segment", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await open(page, "denial-optional-tool");
    await expect(page.getByTestId("segment-denial-badge")).toHaveText("1");
  });

  test("every actionable control meets the 44px touch target on mobile", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await open(page, "interaction-question-pending");
    const undersized = await page.evaluate(() => {
      const selectors = "button:not([hidden]), select, textarea, [role='radio']";
      return [...document.querySelectorAll(selectors)]
        .filter((node) => {
          const element = node as HTMLElement;
          if (element.offsetParent === null) return false;
          const rect = element.getBoundingClientRect();
          return rect.height < 44;
        })
        .map((node) => (node as HTMLElement).className || node.tagName);
    });
    expect(undersized).toEqual([]);
  });

  test("the mobile overflow menu closes with Escape", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await open(page, "thread-baseline");
    await page.getByTestId("overflow-menu-button").click();
    await expect(page.getByTestId("overflow-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("overflow-menu")).toHaveCount(0);
  });

  test("opening Evidence moves focus to its heading", async ({ page }) => {
    await open(page, "thread-baseline");
    await page.getByTestId("evidence-toggle").click();
    await expect(page.getByRole("heading", { name: "Developer tools" })).toBeFocused();
  });

  test("Escape closes the desktop overlay sheet and returns focus to its toggle", async ({
    page,
  }) => {
    // Between the mobile segment and the docked side panel, Evidence renders as
    // an overlay sheet; §9.1 makes Escape dismiss it.
    await page.setViewportSize({ width: 1000, height: 800 });
    await open(page, "thread-baseline");
    await page.getByTestId("evidence-toggle").click();

    const panel = page.getByTestId("evidence-panel");
    await expect(panel).toHaveAttribute("data-layout", "overlay");
    await expect(page.getByRole("heading", { name: "Developer tools" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId("evidence-toggle")).toBeFocused();
  });

  test("resolving an interaction card moves focus to its state chip", async ({ page }) => {
    await open(page, "interaction-question-pending");
    const card = page.locator('[data-interaction-id="ix-questions-01"]');

    await card.getByRole("radio", { name: "Yes — runner owns it" }).check();
    await card.getByRole("combobox").selectOption("hb-baseline");
    await card.getByRole("button", { name: "Submit answers" }).click();

    await expect(card).toHaveAttribute("data-interaction-state", "answered");
    await expect(card.getByTestId("interaction-state-chip")).toBeFocused();
  });

  test("the waiting composer anchor focuses the pending card", async ({ page }) => {
    await open(page, "interaction-question-pending");
    await page.getByTestId("pending-anchor").click();
    await expect(page.locator('[data-interaction-id="ix-questions-01"]')).toBeInViewport();
  });

  for (const slug of CAPABILITY_UI_SHOT_SLUGS) {
    test(`axe reports no serious or critical violation on ${slug} (desktop)`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await open(page, slug, slug === "debug-panel-open" ? { panel: "authorization" } : {});
      expect(await seriousAxeViolations(page)).toEqual([]);
    });

    test(`axe reports no serious or critical violation on ${slug} (mobile)`, async ({ page }) => {
      await page.setViewportSize(MOBILE);
      await open(page, slug, slug === "debug-panel-open" ? { panel: "authorization", seg: "evidence" } : {});
      expect(await seriousAxeViolations(page)).toEqual([]);
    });
  }
});

/* ------------------------------------------------------- Capability clean room */

/**
 * The clean room is live-only by construction, so these tests stub the package
 * session route rather than starting a real Codex process: what is under test
 * here is the surface — entry, blank state, evidence-on-demand, identity
 * rotation, failure honesty, and the narrow layout — not the tool loop, which
 * `smoke:capability:cleanroom` and the server suite cover against the real thing.
 */

const CLEAN_ROOM_API = "**/api/capability/ui/cleanroom/session*";
const DEVTOOLS_API = "**/api/capability/ui/devtools?*";

function devtoolsPayload() {
  const state = {
    company: { id: "company-1", name: "Mock Paperclip" },
    actors: [], tasks: [], comments: [], interactions: [], approvals: [], artifacts: [],
    workProducts: [], blockers: [], workspaceServices: [], budgets: [], runs: [], wakes: [],
    audit: [], decisions: [], idempotency: [], faults: [],
    documents: [{
      id: "document-1",
      key: "plan",
      title: "Runner plan",
      revisions: [{ id: "revision-1", revision: 1, body: "# Real document body\n\nInspectable from DevTools.", changeSummary: "Initial draft", createdAt: "2026-08-10T12:00:00.000Z" }],
    }],
  };
  return {
    schema: "paperclip.capability.devtools.v1",
    currentRevision: 4,
    revisions: [{ revision: 4, at: "2026-08-10T12:00:00.000Z", turnId: "turn-1", operationId: "write_document", state }],
    protocol: [], runtime: {}, authority: {},
  };
}

function cleanRoomView(identifier: string, withTurn: boolean) {
  const guard = {
    id: `network-guard-session-${identifier}`,
    turnId: "turn-0",
    category: "session",
    outcome: "no_real_paperclip_request",
    reason: "Real Paperclip API requests: 0. Child PAPERCLIP_* environment keys: none.",
    stateRevision: 3,
    threadAnchorId: null,
  };
  return {
    schema: "paperclip.capability.issue-thread-view.v1",
    sessionId: `session-${identifier}`,
    mode: "live",
    identity: {
      agentLabel: "Real Codex",
      runnerLabel: "Real runnerd",
      runnerAttached: true,
      controlPlaneLabel: "Mock Paperclip",
      controlPlaneTooltip: "All issue records are mock. No real Paperclip API is reachable.",
      replaySource: null,
    },
    issue: {
      identifier,
      title: "Clean-room chat",
      status: "in_progress",
      priority: "medium",
      assignee: "Mock Agent",
      runState: `run-${identifier} · idle`,
      scenarioId: "capability-clean-room",
      fixtureProfile: "clean-room",
    },
    turns: withTurn
      ? [
          {
            id: "turn-1",
            ordinal: 1,
            mode: "live",
            toolCallCount: 1,
            at: "2026-08-10T12:00:00.000Z",
            stoppedByUser: false,
            items: [
              {
                kind: "user_message",
                id: "transcript-1",
                at: "2026-08-10T12:00:00.000Z",
                author: "You (board user)",
                body: "Read this issue and record a status.",
              },
              {
                kind: "tool_activity",
                id: "item-call-call-1",
                at: "2026-08-10T12:00:01.000Z",
                status: "ok",
                operationId: "report_progress",
                summary: "state revision 3",
                input: { body: "first status" },
                result: { ok: true, stateRevision: 3 },
                evidenceRef: { section: "calls", recordId: "call-1" },
              },
              {
                kind: "agent_message",
                id: "transcript-2",
                at: "2026-08-10T12:00:02.000Z",
                author: "Real Codex",
                body: "Recorded a first status on the mock issue.",
                streaming: false,
              },
            ],
          },
        ]
      : [],
    composer: { state: "ready", helper: null, reason: null, pendingInteractionId: null },
    evidence: {
      tools: [],
      calls: [],
      authorization: [],
      control_plane: [guard],
      runner: [],
      state: [],
      traceability: [],
      parity: [],
    },
    connection: { state: "connected", attempt: 0 },
    replay: null,
    renderedAt: "2026-08-10T12:00:02.000Z",
  };
}

function cleanRoomPayload(identifier: string, withTurn = false) {
  return {
    sessionId: `session-${identifier}`,
    surface: "cleanroom",
    identity: {
      token: identifier.toLowerCase().replace("mck-", "tok"),
      sequence: Number(identifier.slice(4)),
      companyId: `company-cleanroom-${identifier}`,
      actorId: `actor-cleanroom-${identifier}`,
      taskId: `task-cleanroom-${identifier}`,
      identifier,
    },
    limits: { maxTurns: 24, maxMessageBytes: 8192 },
    view: cleanRoomView(identifier, withTurn),
  };
}

/**
 * A turn now answers with the NDJSON stream, so a stubbed turn has to speak it.
 * These stubs deliver one settled frame: they exercise what a turn *produced*,
 * while incremental delivery is proved against the real server below.
 */
function turnStreamBody(payload: unknown, interim: unknown[] = []): string {
  const frames = interim.map((view, index) => ({
    schema: "paperclip.capability.turn-stream.v1",
    type: "frame",
    seq: index + 1,
    reason: "delta",
    turnId: "turn-1",
    view,
  }));
  return [
    ...frames,
    {
      schema: "paperclip.capability.turn-stream.v1",
      type: "settled",
      seq: frames.length + 1,
      payload,
    },
  ]
    .map((frame) => `${JSON.stringify(frame)}\n`)
    .join("");
}

async function stubCleanRoom(page: Page, identifiers: string[]) {
  let opened = 0;
  await page.route(CLEAN_ROOM_API, async (route) => {
    const requestedSessionId = new URL(route.request().url()).searchParams.get("sessionId");
    const identifier = requestedSessionId?.replace(/^session-/, "")
      ?? identifiers[Math.min(opened, identifiers.length - 1)]
      ?? "MCK-1000";
    if (requestedSessionId === null) opened += 1;
    await route.fulfill({
      status: route.request().method() === "POST" ? 201 : 200,
      contentType: "application/json",
      body: JSON.stringify(cleanRoomPayload(identifier)),
    });
  });
}

async function openCleanRoom(page: Page, identifiers: string[] = ["MCK-1000"]) {
  await stubCleanRoom(page, identifiers);
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/#/chat");
  await expect(page.locator('[data-thread-state="settled"]')).toBeVisible();
}

test.describe("Capability clean-room chat", () => {
  test("the landing surface offers a clean-room entry that needs no scenario", async ({ page }) => {
    await open(page, "thread-baseline");
    const entry = page.getByTestId("surface-chat-link");
    await expect(entry).toBeVisible();
    await expect(entry).toHaveRole("button");
    await expect(entry).toContainText("New chat");
  });

  test("a new chat opens a blank live thread with no scenario controls", async ({ page }) => {
    await openCleanRoom(page);

    await expect(page).toHaveTitle("🫧 Mock Paperclip · Issue thread");
    await expect(page.locator('[data-surface="chat"]')).toBeVisible();
    await expect(page.getByTestId("clean-room-empty")).toBeVisible();
    await expect(page.locator("[data-turn-id]")).toHaveCount(0);
    await expect(page.getByTestId("scenario-picker")).toHaveCount(0);
    await expect(page.getByTestId("replay-button")).toHaveCount(0);
    await expect(page.getByTestId("replay-strip")).toHaveCount(0);

    const chips = page.getByTestId("identity-chips");
    await expect(chips.getByTestId("agent-chip")).toHaveText("Real Codex");
    await expect(chips.getByTestId("runner-chip")).toContainText("Real runnerd");
    await expect(chips.getByTestId("control-plane-chip")).toHaveText("Mock Paperclip");
    await expect(page.locator('[data-composer-state="ready"]')).toHaveCount(1);
  });

  test("evidence stays collapsed until it is asked for", async ({ page }) => {
    await openCleanRoom(page);

    await expect(page.locator(".pit-panel")).toHaveCount(0);
    await expect(page.getByTestId("evidence-toggle")).toHaveAttribute("aria-expanded", "false");

    await page.getByTestId("evidence-toggle").click();
    await expect(page.locator(".pit-panel")).toBeVisible();
    await page.getByRole("button", { name: /Control plane/ }).click();
    await expect(page.getByText("Real Paperclip API requests: 0")).toBeVisible();
  });

  test("documents written to company state are readable in DevTools", async ({ page }) => {
    await page.route(DEVTOOLS_API, async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(devtoolsPayload()) });
    });
    await openCleanRoom(page);
    await page.getByTestId("evidence-toggle").click();
    const panel = page.getByTestId("evidence-panel");
    const tabs = panel.getByRole("tab");
    await expect(tabs.first()).toHaveText(/Evidence/);
    await expect(tabs.nth(1)).toHaveText(/Timeline/);
    await expect(panel.locator(".pit-devtools-tabs .pit-icon")).toHaveCount(8);
    const centerOffsets = await tabs.evaluateAll((elements) => elements.map((element) => {
      const icon = element.querySelector(".pit-tab-glyph")?.getBoundingClientRect();
      const label = element.querySelector(".pit-tab-glyph + span")?.getBoundingClientRect();
      return icon === undefined || label === undefined
        ? Number.POSITIVE_INFINITY
        : Math.abs((icon.top + icon.height / 2) - (label.top + label.height / 2));
    }));
    expect(Math.max(...centerOffsets)).toBeLessThanOrEqual(1);
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    await expect(panel.locator("#evidence-turn-selector")).toBeVisible();
    await panel.getByRole("tab", { name: /Timeline/ }).click();
    await expect(panel.locator("#evidence-turn-selector")).toHaveCount(0);
    await panel.getByRole("tab", { name: /Evidence/ }).click();
    await expect(panel.locator("#evidence-turn-selector")).toBeVisible();
    await page.getByRole("tab", { name: /Documents/ }).click();
    await expect(page.getByRole("heading", { name: "Runner plan" })).toBeVisible();
    await expect(page.getByText("Inspectable from DevTools.")).toBeVisible();
  });

  test("Runner events expand completely while stream deltas stay grouped", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.route(CLEAN_ROOM_API, async (route) => {
      const payload = cleanRoomPayload("MCK-1000");
      const view = payload.view as CapabilityIssueThreadSnapshot;
      view.evidence.runner = [
        {
          id: "session-1",
          turnId: "turn-0",
          kind: "session",
          ordinal: 1,
          detail: "session · started",
          details: [
            { label: "Action", value: "started" },
            { label: "Runner", value: "paperclip-runnerd" },
          ],
        },
        ...[2, 3].map((ordinal) => ({
          id: `delta-${ordinal}`,
          turnId: "turn-1",
          kind: "provider_event",
          ordinal,
          detail: "provider event · assistant_delta",
          details: [{ label: "Event", value: "assistant_delta" }],
        })),
      ];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    });
    await page.goto("/#/chat");
    await expect(page.locator('[data-thread-state="settled"]')).toBeVisible();

    await page.getByTestId("evidence-toggle").click();
    await page.getByRole("button", { name: /Runner & events/ }).click();

    const session = page.locator('[data-record-id="session-1"]');
    await session.locator("summary").click();
    await expect(session).toContainText("paperclip-runnerd");

    const group = page.locator('[data-runner-delta-group="assistant_delta"]');
    await expect(group).toContainText("2 streamed updates");
    await group.locator(":scope > summary").click();
    await expect(group.locator(".pit-runner-event")).toHaveCount(2);
    await group.locator(".pit-runner-event").first().locator("summary").click();
    await expect(group.locator(".pit-runner-event").first()).toContainText("assistant_delta");
  });

  test("a sent message renders the live turn it produced", async ({ page }) => {
    await openCleanRoom(page);
    await page.route("**/api/capability/ui/message", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: turnStreamBody({
          sessionId: "session-MCK-1000",
          surface: "cleanroom",
          identity: cleanRoomPayload("MCK-1000").identity,
          limits: { maxTurns: 24, maxMessageBytes: 8192 },
          view: cleanRoomView("MCK-1000", true),
        }),
      });
    });

    await page.locator("#composer-input").fill("Read this issue and record a status.");
    await page.getByTestId("composer-send").click();

    await expect(page.getByTestId("clean-room-empty")).toHaveCount(0);
    await expect(page.locator('[data-thread-item="user_message"]')).toBeVisible();
    await expect(page.locator('[data-thread-item="agent_message"]')).toBeVisible();
    await expect(page.locator('[data-tool-strip="report_progress"]')).toBeVisible();
  });

  test("New chat visibly rotates the mock identity", async ({ page }) => {
    await openCleanRoom(page, ["MCK-1000", "MCK-2000"]);
    await expect(page.locator(".pit-identifier")).toHaveText("MCK-1000");

    await page.getByTestId("surface-chat-link").click();
    await expect(page.locator(".pit-identifier")).toHaveText("MCK-2000");
    await expect(page.getByTestId("clean-room-empty")).toBeVisible();
    const history = page.getByRole("region", { name: "Session history" });
    await expect(history.getByRole("button")).toHaveCount(2);

    await history.getByRole("button", { name: /MCK-1000/ }).click();
    await expect(page.locator(".pit-identifier")).toHaveText("MCK-1000");
    await expect(page.locator("#composer-input")).toBeEnabled();

    await history.getByRole("button", { name: /MCK-2000/ }).click();
    await expect(page.locator(".pit-identifier")).toHaveText("MCK-2000");
    await expect(page.locator("#composer-input")).toBeEnabled();
  });

  test("a failed live start reports the failure instead of a fixture", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.route(CLEAN_ROOM_API, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "capability_issue_thread_unavailable",
          message: "paperclip-runnerd exited before the Codex app-server was ready",
        }),
      });
    });
    await page.goto("/#/chat");

    const error = page.getByTestId("surface-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("could not start the selected provider");
    await expect(page.getByTestId("surface-error-retry")).toBeVisible();
    await expect(page.locator("[data-turn-id]")).toHaveCount(0);
  });

  test("the narrow layout keeps thread and composer usable without horizontal scroll", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    await openCleanRoom(page);

    await expect(page.getByTestId("clean-room-empty")).toBeVisible();
    await expect(page.locator("#composer-input")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await page.getByTestId("segment-evidence").click();
    await expect(page.locator(".pit-panel")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
  });

  test("axe reports no serious or critical violation on the clean room", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openCleanRoom(page);
    expect(await seriousAxeViolations(page)).toEqual([]);

    await page.setViewportSize(MOBILE);
    await expect(page.getByTestId("clean-room-empty")).toBeVisible();
    expect(await seriousAxeViolations(page)).toEqual([]);
  });
});

/* ------------------------------------ pending-request live region (TASK-16978) */

/**
 * Clean-room QA (TASK-16974) heard the visually hidden status region still
 * announce "A request is waiting for your answer." after the request had been
 * answered: the live path re-renders with the same request still pending while
 * the submit is in flight, which used to re-arm the pending copy and leave it
 * standing once the request settled. These tests pin the live region to the
 * request's actual state across pending → answered → a later turn.
 */

const PENDING_ANNOUNCEMENT = "A request is waiting for your answer.";

function questionsItem(state: "pending" | "answered" | "withdrawn"): CapabilityThreadItem {
  return {
    kind: "interaction",
    id: "item-ix-1",
    at: "2026-08-10T12:00:03.000Z",
    interactionId: "ix-questions-01",
    interactionKind: "questions",
    title: "One scoping question",
    prompt: "Answer this before I continue.",
    payload: {
      kind: "questions",
      submitLabel: "Submit answers",
      questions: [
        {
          id: "q1",
          prompt: "Should the runner own process cleanup?",
          control: "radio",
          options: ["Yes — runner owns it", "No — harness owns it"],
          required: true,
        },
      ],
    },
    state,
    target: null,
    stateLabel:
      state === "pending" ? "Waiting for you" : state === "answered" ? "Answered" : "Withdrawn",
    resolvedSummary:
      state === "answered" ? ["Should the runner own process cleanup? Yes — runner owns it"] : [],
    reason: null,
    supersededBy: null,
    evidenceRef: { section: "authorization", recordId: "authz-ix-1" },
  };
}

/** A clean-room view carrying one request in the given state. */
function interactionView(
  identifier: string,
  state: "pending" | "answered",
  options: { withdrawn?: boolean; extraTurn?: boolean } = {},
): CapabilityIssueThreadSnapshot {
  const view = JSON.parse(
    JSON.stringify(cleanRoomView(identifier, true)),
  ) as CapabilityIssueThreadSnapshot;
  view.turns[0].items.push(questionsItem(options.withdrawn === true ? "withdrawn" : state));
  if (options.extraTurn === true) {
    view.turns.push({
      id: "turn-2",
      ordinal: 2,
      mode: "live",
      toolCallCount: 0,
      at: "2026-08-10T12:01:00.000Z",
      stoppedByUser: false,
      items: [
        {
          kind: "user_message",
          id: "transcript-3",
          at: "2026-08-10T12:01:00.000Z",
          author: "You (board user)",
          body: "Carry on with the plan.",
        },
        {
          kind: "agent_message",
          id: "transcript-4",
          at: "2026-08-10T12:01:01.000Z",
          author: "Real Codex",
          body: "Folded the answer into the plan.",
          streaming: false,
        },
      ],
    });
  }
  view.composer =
    state === "pending"
      ? {
          state: "waiting",
          helper: "Answer the pending request above to continue.",
          reason: null,
          pendingInteractionId: "ix-questions-01",
        }
      : { state: "ready", helper: null, reason: null, pendingInteractionId: null };
  return view;
}

async function openWithPendingRequest(page: Page) {
  await page.addInitScript(() => window.localStorage.clear());
  await page.route(CLEAN_ROOM_API, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...cleanRoomPayload("MCK-1000"),
        view: interactionView("MCK-1000", "pending"),
      }),
    });
  });
  await page.goto("/#/chat");
  await expect(page.locator('[data-thread-state="settled"]')).toBeVisible();
}

test.describe("pending-request live region", () => {
  test("the pending announcement is dropped once the request is answered", async ({ page }) => {
    await openWithPendingRequest(page);

    const live = page.getByTestId("thread-live-region");
    await expect(live).toHaveText(PENDING_ANNOUNCEMENT);
    await expect(page.locator('[data-composer-state="waiting"]')).toBeVisible();

    let interactionRequests = 0;
    await page.route("**/api/capability/ui/interaction", async (route) => {
      interactionRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...cleanRoomPayload("MCK-1000"),
          view: interactionView("MCK-1000", "answered"),
        }),
      });
    });

    const card = page.locator('[data-interaction-id="ix-questions-01"]');
    await card.getByRole("radio", { name: "Yes — runner owns it" }).check();
    await card.getByRole("button", { name: "Submit answers" }).click();

    await expect(card).toHaveAttribute("data-interaction-state", "answered");
    expect(interactionRequests).toBe(1);
    await expect(page.locator('[data-composer-state="ready"]')).toHaveCount(1);
    await expect(live).not.toContainText(PENDING_ANNOUNCEMENT);
    await expect(live).toHaveText("Your answer was recorded.");

    // A later turn must not resurrect the pending guidance either.
    await page.route("**/api/capability/ui/message", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: turnStreamBody({
          ...cleanRoomPayload("MCK-1000"),
          view: interactionView("MCK-1000", "answered", { extraTurn: true }),
        }),
      });
    });
    await page.locator("#composer-input").fill("Carry on with the plan.");
    await page.getByTestId("composer-send").click();

    await expect(page.locator("[data-turn-id]")).toHaveCount(2);
    await expect(live).not.toContainText(PENDING_ANNOUNCEMENT);
  });

  test("a request withdrawn server-side replaces the pending announcement", async ({ page }) => {
    // Nobody answers here: the request goes away while the session is
    // reconnecting, so the correction has to come from the settled snapshot.
    await page.addInitScript(() => window.localStorage.clear());
    await page.route(CLEAN_ROOM_API, async (route) => {
      const view = interactionView("MCK-1000", "pending");
      view.composer.state = "reconnecting";
      view.connection = { state: "reconnecting", attempt: 2 };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...cleanRoomPayload("MCK-1000"), view }),
      });
    });
    await page.goto("/#/chat");
    await expect(page.locator('[data-thread-state="settled"]')).toBeVisible();

    const live = page.getByTestId("thread-live-region");
    await expect(live).toHaveText(PENDING_ANNOUNCEMENT);

    await page.route("**/api/capability/ui/reconnect", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...cleanRoomPayload("MCK-1000"),
          view: interactionView("MCK-1000", "answered", { withdrawn: true }),
        }),
      });
    });
    await page.getByRole("button", { name: "Retry now" }).click();

    await expect(page.locator('[data-interaction-state="withdrawn"]')).toBeVisible();
    await expect(live).not.toContainText(PENDING_ANNOUNCEMENT);
    await expect(live).toHaveText("The pending request is resolved. Withdrawn.");
  });
});

/* -------------------------------------------- Capability streamed live turn */

/**
 * Streaming is proved against the real package server, not a stub: port 4185
 * runs the same built bundle and the same session middleware with a scripted
 * Codex provider (`vite.issue-thread-stream.config.ts`), so the NDJSON turn
 * stream, the live session, the projection, and the browser client are all the
 * shipped code. A `route.fulfill` stub cannot show this — it can only deliver a
 * body in one piece, which is exactly the behaviour under repair.
 */

const STREAM_ORIGIN = "http://127.0.0.1:4185";
const STREAM_REPLY =
  "Reading the clean-room issue. It is blank, with one mock agent and one mock task. " +
  "Recording a first status against the mock control plane. Done — every record stayed in the mock port.";

async function openStreamingCleanRoom(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto(`${STREAM_ORIGIN}/#/chat`);
  await expect(page.locator('[data-thread-state="settled"]')).toBeVisible({ timeout: 60_000 });
}

test.describe("Capability streamed live turn", () => {
  test("shows sanitized thinking progress before assistant text arrives", async ({ page }) => {
    await openStreamingCleanRoom(page);

    await page.locator("#composer-input").fill("Show progress while you inspect this issue.");
    await page.getByTestId("composer-send").click();
    const liveActivity = page.getByTestId("live-activity");
    await expect(liveActivity).toBeVisible();

    const progress = page.locator('[data-thread-item="progress_activity"][data-activity="thinking"]');
    await expect(progress).toBeVisible({ timeout: 30_000 });
    await expect(progress).toHaveAttribute("data-status", "running");
    await expect(progress).toContainText("Thinking");
    await expect(liveActivity).toContainText(/Reasoning|Thinking|Codex/);
    await expect(page.locator('[data-thread-item="agent_message"]')).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(
      "PRIVATE reasoning text must never reach the browser.",
    );

    await expect(page.locator('[data-thread-item="agent_message"]')).toContainText(STREAM_REPLY, {
      timeout: 60_000,
    });
    await expect(progress).toHaveAttribute("data-status", "complete");
  });

  test("one assistant card grows while the turn POST is still open", async ({ page }) => {
    await openStreamingCleanRoom(page);

    const states: Array<{ id: string; body: string }> = [];
    let pendingWhileGrowing = 0;
    let settledWhileGrowing = 0;
    let turnFinished = false;
    // Sample the rendered card, not the network: what has to be proved is that
    // a reader sees the reply grow, and only the DOM can say that.
    const sampler = (async () => {
      while (!turnFinished) {
        const sample = await page.evaluate(() => {
          const card = document.querySelector('[data-thread-item="agent_message"]');
          const app = document.querySelector(".pit-app");
          return {
            id: card?.id ?? null,
            body: card?.querySelector(".pit-card-body")?.textContent ?? null,
            threadState: app?.getAttribute("data-thread-state") ?? null,
            composer:
              document.querySelector("[data-composer-state]")?.getAttribute("data-composer-state") ??
              null,
          };
        });
        if (sample.id !== null && sample.body !== null && sample.body.length > 0) {
          if (states.at(-1)?.body !== sample.body) states.push({ id: sample.id, body: sample.body });
          if (sample.body !== STREAM_REPLY) {
            pendingWhileGrowing += 1;
            if (sample.threadState === "settled") settledWhileGrowing += 1;
          }
        }
        await page.waitForTimeout(60);
      }
    })();

    await page.locator("#composer-input").fill("Read this issue and record a status.");
    await page.getByTestId("composer-send").click();

    // The whole reply only appears at the end; the card gets there in pieces.
    await expect(page.locator('[data-thread-item="agent_message"]')).toContainText(STREAM_REPLY, {
      timeout: 60_000,
    });
    turnFinished = true;
    await sampler;

    const bodies = states.map((state) => state.body);
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    // One card: every observed state belonged to the same transcript entry.
    expect(new Set(states.map((state) => state.id)).size).toBe(1);
    for (let index = 1; index < bodies.length; index += 1) {
      expect(bodies[index]!.startsWith(bodies[index - 1]!)).toBe(true);
    }
    expect(bodies.at(-1)).toBe(STREAM_REPLY);
    // Partial states were observed, and the surface never claimed to be
    // settled while one of them was on screen.
    expect(pendingWhileGrowing).toBeGreaterThanOrEqual(2);
    expect(settledWhileGrowing).toBe(0);

    // Settled arrives only after the terminal frame.
    await expect(page.locator('[data-thread-state="settled"]')).toBeVisible();
    await expect(page.locator('[data-composer-state="ready"]')).toHaveCount(1);
    await expect(page.locator('[data-thread-item="agent_message"]')).toHaveCount(1);
    await expect(page.locator('[data-thread-item="agent_message"]')).toHaveAttribute(
      "data-streaming",
      "false",
    );
  });

  test("Stop interrupts the streamed turn and keeps the partial reply", async ({ page }) => {
    await openStreamingCleanRoom(page);

    await page.locator("#composer-input").fill("Start a long answer so I can stop it.");
    await page.getByTestId("composer-send").click();

    const card = page.locator('[data-thread-item="agent_message"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute("data-streaming", "true");
    const partial = ((await card.locator(".pit-card-body").textContent()) ?? "").trim();
    expect(partial.length).toBeGreaterThan(0);
    expect(STREAM_REPLY.startsWith(partial)).toBe(true);

    await page.getByTestId("composer-stop").click();

    // The stopped turn settles on what it had said, and nothing lands later.
    await expect(page.locator('[data-thread-state="settled"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("stopped-marker")).toBeVisible();
    const stopped = ((await card.locator(".pit-card-body").textContent()) ?? "").trim();
    expect(STREAM_REPLY.startsWith(stopped)).toBe(true);
    expect(stopped).not.toBe(STREAM_REPLY);
    await page.waitForTimeout(1_500);
    expect(((await card.locator(".pit-card-body").textContent()) ?? "").trim()).toBe(stopped);
    await expect(page.locator('[data-thread-item="agent_message"]')).toHaveCount(1);
  });
});
