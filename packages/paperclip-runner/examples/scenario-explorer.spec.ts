import { expect, test, type Page } from "@playwright/test";

/**
 * Capability browser acceptance.
 *
 * Covers the interaction map's determinism contract (§7), the keyboard paths
 * and landmark structure (§6), and the credential/policy boundary (§5). Screen
 * The recorded §9 screenshot campaign is deferred from this release.
 */

const BASE = "/scenario-explorer/";

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`${BASE}${hash}`);
  await expect(page.locator('[data-testid="explorer-shell"]')).toHaveAttribute(
    "data-run-state",
    "settled",
    { timeout: 30_000 },
  );
}

test.describe("shell and information architecture", () => {
  test("explorer home shows all 16 groups summing to 106 with no dead panel", async ({ page }) => {
    await open(page, "#/");
    await expect(page.locator('[data-testid="scenario-count"]')).toHaveText("106 of 106 scenarios");
    await expect(page.locator('[data-testid="explorer-intro"]')).toBeVisible();

    const counts = await page
      .locator('[data-testid^="facet-group-"] .pcr7-facet-count')
      .allTextContents();
    expect(counts).toHaveLength(16);
    expect(counts.reduce((total, value) => total + Number(value), 0)).toBe(106);

    await expect(page.locator("nav[aria-label='Scenario picker']")).toBeVisible();
    await expect(page.locator("main#run-view")).toBeVisible();
    await expect(page.locator("aside[aria-label='Scenario inspector']")).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
  });

  test("filtered picker route renders chips, counts, and a way out", async ({ page }) => {
    await open(page, "#/?group=ix&disposition=always_agent_tool&parity=not_run");
    await expect(page.locator('[data-testid="active-filter-group"]')).toBeVisible();
    await expect(page.locator('[data-testid="active-filter-disposition"]')).toBeVisible();
    await expect(page.locator('[data-testid="clear-filters"]')).toBeVisible();
    await expect(page.locator('[data-testid="scenario-count"]')).toContainText("of 106 scenarios");
    // A zero-count value stays legible but is not clickable.
    await expect(page.locator('[data-testid="facet-parity-fail"]')).toBeDisabled();
  });
});

test.describe("route determinism", () => {
  test("two loads of the same run route produce identical settled DOM", async ({ page }) => {
    const route = "#/case/ap-mcp-gate-01?run=fake&view=authorization";
    await open(page, route);
    const first = await page.locator('[data-testid="explorer-shell"]').innerHTML();
    await page.reload();
    await expect(page.locator('[data-testid="explorer-shell"]')).toHaveAttribute(
      "data-run-state",
      "settled",
      { timeout: 30_000 },
    );
    const second = await page.locator('[data-testid="explorer-shell"]').innerHTML();
    expect(second).toBe(first);
  });

  test("a fake run renders fixture time only", async ({ page }) => {
    await open(page, "#/case/hb-scoped-wake-01?run=fake&view=transcript");
    const text = (await page.locator('[data-testid="transcript"]').innerText()).toLowerCase();
    const currentYear = String(new Date().getUTCFullYear());
    expect(text).not.toContain(`${currentYear}-`);
    await expect(page.locator('[data-testid="transcript"] [data-channel="control_plane"]').first()).toContainText(
      "no agent tool exists for this",
    );
  });

  test("an unrun scenario primes the run rather than showing a dead panel", async ({ page }) => {
    await open(page, "#/case/hb-scoped-wake-01");
    await expect(page.locator('[data-testid="run-header"]')).toBeVisible();
    await expect(page.locator("main")).toContainText("Run to produce the deterministic timeline.");
    await expect(page.locator('[data-testid="run-button"]')).toBeVisible();
  });

  test("an unknown case route renders a named error and returns to the picker", async ({ page }) => {
    await open(page, "#/case/not-a-real-scenario");
    await expect(page.locator('[data-testid="unknown-scenario"]')).toContainText(
      "No scenario named not-a-real-scenario",
    );
    await page.getByRole("link", { name: "Back to the scenario picker" }).click();
    await expect(page.locator('[data-testid="explorer-intro"]')).toBeVisible();
    expect(page.url()).toContain("#/");
  });
});

test.describe("acceptance evidence", () => {
  test("authorization view shows a deny row and a tab deny count", async ({ page }) => {
    await open(page, "#/case/ap-mcp-gate-01?run=fake&view=authorization");
    await expect(page.locator('[data-testid="panel-authorization"] tr[data-outcome="denied"]')).toHaveCount(1);
    await expect(page.locator('[role="tab"]', { hasText: "Authorization" })).toContainText("deny");
    await expect(page.locator('[data-testid="transcript"] [data-outcome="denied"]').first()).toContainText(
      "required_claim_missing",
    );
  });

  test("context view lists optional tools with the grant that unlocked them", async ({ page }) => {
    await open(page, "#/case/rf-api-mgr-heartbeat-01?run=fake&view=context");
    await expect(page.locator('[data-testid="exposure-optional"]')).toContainText("discovery:agents:read");
    await expect(page.locator('[data-testid="exposure-control-plane"]')).toContainText("checkout_task");
    await expect(page.locator('[data-testid="panel-context"]')).toContainText("Manager");
  });

  test("state diff collapses unchanged domains and marks changes with icon plus label", async ({ page }) => {
    await open(page, "#/case/bl-create-blocked-01?run=fake&view=diff");
    await expect(page.locator('[data-testid="diff-domain-blockers"]')).toHaveAttribute("data-changed", "true");
    await expect(page.locator('[data-testid="diff-domain-approvals"]')).toHaveAttribute("data-changed", "false");
    await expect(page.locator('[data-testid="diff-domain-tasks"]')).toContainText("Added");
  });

  test("restraint reads as deliberate absence, not an empty screen", async ({ page }) => {
    await open(page, "#/case/rs-question-only-01?run=fake&view=parity");
    await expect(page.locator('[data-testid="restraint-note"]')).toContainText("No further operations");
    await expect(page.locator('[data-testid="parity-verdict"]')).toContainText("Pass");
    await expect(page.locator('[data-testid="parity-forbidden"]')).toBeVisible();
  });

  test("redaction chips name the rule and never the value", async ({ page }) => {
    await open(page, "#/case/rs-secret-hygiene-01?run=fake&view=transcript");
    await page.locator('[data-testid="transcript"] details').first().evaluate((node) => {
      for (const element of document.querySelectorAll("details")) element.setAttribute("open", "");
      return node.tagName;
    });
    await expect(page.locator('[data-testid="redaction-chip"]').first()).toBeVisible();
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("fixture-secret-value-not-a-real-credential");
  });

  test("checkbox continuation routes, inspects, and acts on selectedOptionIds", async ({ page }) => {
    await open(page, "#/case/ix-checkbox-result-01?run=fake&view=transcript");
    const entries = page.locator('[data-testid="transcript"] > li');
    await expect(entries.filter({ hasText: "result.selectedOptionIds" }).first()).toContainText(
      "Control plane routed",
    );
    await expect(entries.filter({ hasText: "inspect_operation_result" }).first()).toBeVisible();
    await expect(
      page.locator('[data-testid="transcript"] [data-channel="agent"]', {
        hasText: "create_task",
      }),
    ).toHaveCount(8);
  });
});

test.describe("credential and policy boundary", () => {
  test("fake mode performs no network request beyond its own assets", async ({ page }) => {
    const external: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith("http://127.0.0.1:4193")) external.push(request.url());
    });
    await open(page, "#/case/mh-subtask-tree-01?run=fake&view=parity");
    expect(external).toEqual([]);
  });

  test("localStorage holds no run artifact, grant, or fixture payload", async ({ page }) => {
    await open(page, "#/case/hb-scoped-wake-01?run=fake");
    const stored = await page.evaluate(() => JSON.stringify(window.localStorage));
    expect(stored).toBe("{}");
  });

  test("Codex mode is disabled with a stated reason and fake mode stays usable", async ({ page }) => {
    await open(page, "#/case/hb-scoped-wake-01?run=fake");
    await expect(page.locator('[data-testid="mode-codex"]')).toBeDisabled();
    await expect(page.locator('[data-testid="codex-unavailable"]')).toContainText(
      "provider relay not running",
    );
    await expect(page.locator('[data-testid="mode-fake"]')).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("keyboard and accessibility", () => {
  test("the picker listbox moves selection with the arrow keys", async ({ page }) => {
    await open(page, "#/?group=ix");
    const list = page.locator('[data-testid="case-list"]');
    await list.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator('[data-testid="case-list"] [aria-selected="true"]')).toHaveCount(1);
    const first = await page.locator('[data-testid="case-list"] [aria-selected="true"]').getAttribute("id");
    await list.focus();
    await page.keyboard.press("ArrowDown");
    const second = await page.locator('[data-testid="case-list"] [aria-selected="true"]').getAttribute("id");
    expect(second).not.toBe(first);
    await expect(list).toHaveAttribute("aria-activedescendant", String(second));
  });

  test("picker type-ahead selects a match and Enter moves focus to the run header", async ({ page }) => {
    await open(page, "#/?group=ix");
    const list = page.locator('[data-testid="case-list"]');
    await list.focus();
    await page.keyboard.type("ix-checkbox-result");
    await expect(list).toHaveAttribute(
      "aria-activedescendant",
      "case-row-ix-checkbox-result-01",
    );
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="run-header"]')).toBeFocused();
  });

  test("the documented shortcut cycles picker, run, and inspector regions", async ({ page }) => {
    await open(page, "#/case/hb-scoped-wake-01?run=fake&view=context");
    await expect(page.locator('[data-testid="explorer-shell"]')).toHaveAttribute(
      "aria-keyshortcuts",
      "F6 Control+.",
    );
    await page.locator('[data-testid="scenario-picker"]').focus();
    await page.keyboard.press("Control+.");
    await expect(page.locator("main#run-view")).toBeFocused();
    await page.keyboard.press("Control+.");
    await expect(page.locator("aside[aria-label='Scenario inspector']")).toBeFocused();
    await page.keyboard.press("Control+.");
    await expect(page.locator('[data-testid="scenario-picker"]')).toBeFocused();
  });

  test("inspector tabs follow the WAI-ARIA arrow-key pattern", async ({ page }) => {
    await open(page, "#/case/hb-scoped-wake-01?run=fake&view=context");
    // Exactly one tablist on the page: the mobile section switcher is a
    // radiogroup so the three landmarks are not modelled as tabpanels.
    await expect(page.locator('[role="tablist"]')).toHaveCount(1);
    const selected = page.locator('[role="tab"][aria-selected="true"]');
    await page.locator('[role="tab"]').first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(selected).toContainText("Authorization");
    await page.keyboard.press("ArrowRight");
    await expect(selected).toContainText("State diff");
    await expect(page.locator('[role="tabpanel"]')).toBeVisible();
    for (const name of ["context", "authorization", "diff", "parity"]) {
      await expect(page.locator(`[data-testid="inspector-tab-${name}"]`)).toHaveAttribute(
        "role",
        "tab",
      );
    }
  });

  test("every interactive control is reachable and named", async ({ page }) => {
    await open(page, "#/case/ap-mcp-gate-01?run=fake&view=authorization");
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll("button, input, [role='tab'], [role='radio']")]
        .filter((element) => {
          const label =
            element.getAttribute("aria-label") ??
            element.getAttribute("title") ??
            (element.textContent ?? "").trim();
          const labelled =
            element.id.length > 0 &&
            document.querySelector(`label[for="${CSS.escape(element.id)}"]`) !== null;
          return label.length === 0 && !labelled;
        })
        .map((element) => element.outerHTML.slice(0, 120)),
    );
    expect(unnamed).toEqual([]);
  });

  test("run progress is announced through a polite live region", async ({ page }) => {
    await open(page, "#/case/hb-scoped-wake-01?run=fake");
    await expect(page.locator('[role="status"][aria-live="polite"]')).toContainText(
      "Scenario run settled — verdict pass",
    );
  });

  test("a denied transcript result has exactly one assertive announcement", async ({ page }) => {
    await open(page, "#/case/ap-mcp-gate-01?run=fake&view=transcript");
    const announcement = page.locator('[data-testid="denial-announcement"]');
    await expect(announcement).toHaveCount(1);
    await expect(announcement).toHaveAttribute("aria-live", "assertive");
    await expect(announcement).toContainText("request_approval denied");
  });
});

test.describe("responsive", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("mobile shows one segment at a time with no horizontal scrollbar", async ({ page }) => {
    await open(page, "#/case/ap-mcp-gate-01?run=fake&view=transcript");
    await expect(page.locator('[data-testid="segment-run"]')).toBeVisible();
    await expect(page.locator('[data-testid="explorer-shell"]')).toHaveAttribute("data-segment", "run");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("mobile inspector routes open the Inspect segment", async ({ page }) => {
    await open(page, "#/case/rf-api-mgr-heartbeat-01?run=fake&view=context");
    await expect(page.locator('[data-testid="explorer-shell"]')).toHaveAttribute(
      "data-segment",
      "inspect",
    );
    await expect(page.locator('[data-testid="panel-context"]')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("explorer badge overrides preserve exact labels and intrinsic width", async ({ page }) => {
    await open(page, "#/case/hb-scoped-wake-01?run=fake&view=transcript");
    const badge = page.locator('.pcr-disclosure-summary [data-slot="badge"]').first();
    await expect(badge).toBeVisible();
    const metrics = await badge.evaluate((element) => ({
      textTransform: getComputedStyle(element).textTransform,
      width: element.getBoundingClientRect().width,
      scrollWidth: element.scrollWidth,
    }));
    expect(metrics.textTransform).toBe("none");
    expect(metrics.width + 0.5).toBeGreaterThanOrEqual(metrics.scrollWidth);
  });
});
