import { expect, test, type Locator, type Page } from "@playwright/test";
import { THREAD_PREVIEW_CASES } from "../../ui/src/components/design-sandbox/task-thread-fixtures";

async function openStory(page: Page, id: string) {
  await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:dark`);
}

async function resolvedColor(locator: Locator, token: string): Promise<string> {
  return locator.evaluate((element, tokenName) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${tokenName})`;
    element.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

test("proposal typography reaches shared buttons, prose and identifiers", async ({ page }) => {
  await openStory(page, "design-foundations-typography--type-specification");
  const guide = page.getByTestId("typography-foundations-preview");
  await expect(guide).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(guide.locator("[data-ramp]")).toHaveCount(9);
  await expect(guide.locator('[data-type-sample^="weight-"]')).toHaveCount(2);
  await expect(guide.getByRole("button", { name: "Continue", exact: true })).toHaveCSS("font-weight", "400");
  for (const selector of ['[data-type-sample="detail-id"]', ".paperclip-markdown code", '.task-row-columns [data-column="taskId"]']) {
    const element = guide.locator(selector).first();
    await expect(element).toHaveCSS("font-family", /"Paper Mono"/);
  }
  await expect(guide.locator(".paperclip-markdown a")).toHaveCSS("font-weight", "400");
  await expect(guide.locator(".paperclip-markdown strong")).toHaveCSS("font-weight", "600");
  await expect(guide.locator('[data-type-sample="message-time"]')).toHaveCSS("font-size", "12px");
  await expect(guide.locator('[data-type-sample="message-time"]')).toHaveCSS("line-height", "16px");
  const label = (id: string) => guide.locator(`[data-type-sample="${id}"]`).evaluate(element => {
    const style = getComputedStyle(element);
    return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.letterSpacing, style.color, style.textTransform];
  });
  expect(await label("property-eyebrow")).toEqual(await label("nav-eyebrow"));
});

test("shared sidebar and portaled account menu use the simplified weights and xs metadata", async ({ page }) => {
  await openStory(page, "design-sidebar--default");
  const organization = page.getByRole("button", { name: /organization switcher/ }).locator("[data-cell-marquee]");
  await expect(organization).toHaveCSS("font-weight", "600");
  await expect(page.getByRole("button", { name: "New Task", exact: true })).toHaveCSS("font-weight", "400");
  await page.getByRole("button", { name: "Open account menu", exact: true }).click();
  const header = page.locator("[data-flyout-profile]");
  await expect(header).toBeVisible();
  await expect(header.locator("p")).toHaveCSS("font-size", "12px");
  await expect(header.locator("p")).toHaveCSS("line-height", "16px");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveCSS("font-weight", "400");
});

test("leaving a proposal restores the ordinary foundation typography", async ({ page }) => {
  await openStory(page, "design-foundations-typography--type-specification");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCSS("font-weight", "400");
  await openStory(page, "foundations-primitive-matrix--all-primitives");
  await expect(page.getByRole("heading", { name: "Primitives and interaction states", exact: true })).toBeVisible();
  await expect(page.locator(".design-proposal-theme")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "default", exact: true }).first()).toHaveCSS("font-weight", "500");
  await expect(page.locator(".font-mono").first()).not.toHaveCSS("font-family", /"Paper Mono"/);
  expect(await page.locator("html").evaluate(element => {
    const style = getComputedStyle(element);
    return [style.getPropertyValue("--font-weight-medium").trim(), style.getPropertyValue("--font-weight-bold").trim(), style.getPropertyValue("--text-micro").trim()];
  })).toEqual(["500", "700", "11px"]);
});


test("conversation typography uses the sandbox's complete state catalog and grouped composition", async ({ page }) => {
  await openStory(page, "design-foundations-typography--conversation-styles");
  const preview = page.getByTestId("sandbox-task-thread");
  await expect(preview).toHaveAttribute("data-preview-state", "all");
  expect(THREAD_PREVIEW_CASES).toHaveLength(72);
  await expect(preview.locator("[data-preview-case]")).toHaveCount(THREAD_PREVIEW_CASES.length);
  const selector = preview.getByRole("combobox", { name: "Thread preview state" });
  expect(await selector.locator("optgroup option").evaluateAll(options => options.map(option => ({
    id: (option as HTMLOptionElement).value, label: option.textContent,
    group: option.parentElement?.getAttribute("label"),
  }))).then(options => options.sort((a, b) => a.id.localeCompare(b.id)))).toEqual(THREAD_PREVIEW_CASES.map(({ id, label, group }) => ({ id, label, group })).sort((a, b) => a.id.localeCompare(b.id)));
  expect(await preview.locator("[data-preview-case]").evaluateAll(elements => elements.map(element => element.getAttribute("data-preview-case"))))
    .toEqual(THREAD_PREVIEW_CASES.map(example => example.id));

  await selector.selectOption("staging-conversation");
  await expect(preview.locator("[data-preview-case]")).toHaveCount(1);
  await expect(preview.getByTestId("task-chat-live-run-pill")).toBeVisible();
  await expect(preview.getByTestId("task-chat-runner-turn")).toHaveCount(0);
  await expect(preview.getByText("Thought through the task", { exact: true })).toBeVisible();
  await expect(preview.getByText("Read files", { exact: true })).toBeVisible();
  await expect(preview.getByTestId("task-chat-bubble-attached-turn")).toHaveCount(1);
  await page.getByText("Typography measurements", { exact: true }).click();
  await expect(page.getByTestId("conversation-style-inventory").locator("tbody tr")).not.toHaveCount(0);

  await selector.selectOption("runner-running");
  await expect(preview.getByTestId("task-chat-runner-turn")).toBeVisible();
  await expect(preview.getByTestId("task-chat-live-run-pill")).toHaveCount(0);
});

test("conversation typography keeps permission decisions and replay in the shared preview", async ({ page }) => {
  await openStory(page, "design-foundations-typography--conversation-styles");
  const preview = page.getByTestId("sandbox-task-thread");
  await preview.getByRole("combobox", { name: "Thread preview state" }).selectOption("permission-pending");
  const allow = preview.getByRole("button", { name: "Allow once", exact: true });
  await allow.click();
  await expect(allow).toHaveCount(0);
  await preview.getByRole("button", { name: "Reset / replay", exact: true }).click();
  await expect(allow).toBeVisible();
  await preview.getByRole("button", { name: "Show saved thread", exact: true }).click();
  await expect(preview).toHaveAttribute("data-preview-state", "saved");
  await expect(preview.locator("[data-preview-case]")).toHaveCount(0);
  await expect(preview.getByText(/Saved task data is available in the sandbox/)).toBeVisible();
});

test("conversation type spec measures the shared states and preserves actual sample typography", async ({ page }) => {
  await openStory(page, "design-foundations-typography--conversation-type-specification");
  const guide = page.getByTestId("conversation-type-spec");
  await expect(guide.getByTestId("conversation-type-census")).toContainText("72 states measured");
  const preview = guide.getByTestId("conversation-spec-shared-preview");
  await expect(preview.locator("[data-preview-case]")).toHaveCount(THREAD_PREVIEW_CASES.length);
  await expect(guide.locator("[data-conversation-weight]")).toHaveCount(2);
  await expect(guide.locator("[data-conversation-candidate]").first()).toBeVisible();
  await guide.getByRole("combobox", { name: "Surface", exact: true }).selectOption("Human message");
  const row = guide.locator("[data-conversation-type-role]").first();
  const properties = (element: Element) => {
    const style = getComputedStyle(element);
    return [style.fontFamily, style.fontSize, style.lineHeight, style.fontWeight, style.color, style.letterSpacing];
  };
  expect(await row.locator("[data-conversation-type-sample]").evaluate(properties))
    .toEqual(await preview.getByTestId("task-chat-human-bubble").first().locator("p").first().evaluate(properties));
  await row.getByText("Source & recipe", { exact: true }).click();
  await expect(row.getByText("ui/src/components/task-chat/TaskChatBubble.tsx", { exact: true })).toBeVisible();
  await guide.getByRole("searchbox", { name: "Find a conversation text role" }).fill("no-such-type-recipe");
  await expect(guide.locator("[data-conversation-type-role]")).toHaveCount(0);
  await expect(guide.getByText("No roles match these filters.", { exact: true })).toBeVisible();
});

test("conversation type spec can measure expanded shared content without deciding requests", async ({ page }) => {
  await openStory(page, "design-foundations-typography--conversation-type-specification");
  const guide = page.getByTestId("conversation-type-spec");
  await expect(guide.getByTestId("conversation-type-census")).toContainText("72 states measured");
  const preview = guide.getByTestId("conversation-spec-shared-preview");
  await preview.getByRole("combobox", { name: "Thread preview state" }).selectOption("working");
  await guide.getByRole("button", { name: "Expand details & measure", exact: true }).click();
  await expect(guide.getByTestId("conversation-type-census")).toContainText("1 states measured");
  await expect(preview.getByTestId("task-chat-runner-activity-detail").first()).toBeVisible();
  await expect(guide.locator('[data-conversation-type-role="Activity detail · code / command"]').first()).toBeVisible();
  await preview.getByRole("combobox", { name: "Thread preview state" }).selectOption("permission-pending");
  await guide.getByRole("button", { name: "Expand details & measure", exact: true }).click();
  await expect(preview.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  await guide.getByRole("button", { name: "Show all states", exact: true }).click();
  await expect(preview.locator("[data-preview-case]")).toHaveCount(THREAD_PREVIEW_CASES.length);
  await guide.getByRole("button", { name: "Refresh type inventory", exact: true }).click();
  await expect(guide.getByTestId("conversation-type-census")).toContainText("72 states measured");
});

test("proposal conversation uses two sizes with muted progress, contrasting bubbles and preserved shimmer", async ({ page }) => {
  await openStory(page, "design-foundations-typography--conversation-type-specification");
  const guide = page.getByTestId("conversation-type-spec");
  await expect(guide.getByTestId("conversation-type-census")).toContainText("72 states measured");
  const preview = guide.getByTestId("conversation-spec-shared-preview");
  expect(await guide.locator("[data-conversation-size]").evaluateAll(elements => elements.map(element => element.getAttribute("data-conversation-size")).sort())).toEqual(["12px", "14px"]);
  const human = preview.locator('[data-conversation-text="human"] p').first();
  const final = preview.locator('[data-conversation-text="final"] p').first();
  const progress = preview.locator('[data-conversation-text="progress"] p').first();
  for (const element of [human, final, progress]) {
    await expect(element).toHaveCSS("font-size", "14px");
    await expect(element).toHaveCSS("line-height", "20px");
  }
  await expect(human).toHaveCSS("color", "rgb(255, 255, 255)");
  const foregroundToken = await preview.evaluate(element => getComputedStyle(element).getPropertyValue("--foreground").trim());
  await expect(final).toHaveCSS("color", await resolvedColor(preview, "--foreground"));
  await expect(progress).toHaveCSS("color", await resolvedColor(preview, "--muted-foreground"));
  const pill = preview.locator('[data-preview-case="session-start"]').getByTestId("task-chat-live-run-pill");
  await expect(pill.locator(".shimmer-text")).toHaveCSS("font-size", "14px");
  await expect(pill.locator(".shimmer-text")).toHaveCSS("--shimmer-base", foregroundToken);
  await expect(pill.locator("span").filter({ hasText: /^for / }).last()).toHaveCSS("font-size", "12px");
  await guide.getByRole("button", { name: "Expand details & measure", exact: true }).click();
  expect(await guide.locator("[data-conversation-size]").evaluateAll(elements => elements.map(element => element.getAttribute("data-conversation-size")).sort())).toEqual(["12px", "14px"]);
  await expect(preview.locator('[data-testid="task-chat-runner-activity-detail"] .paperclip-markdown p').first()).toHaveCSS("font-size", "14px");
  const streamingFinal = preview.locator('[data-preview-case="streaming-final"] [data-conversation-text="final"] p').last();
  await expect(streamingFinal).toHaveCSS("color", await resolvedColor(preview, "--foreground"));
  await expect(preview.locator('[data-testid="task-chat-turn-status-header"] [data-conversation-meta]').last()).toHaveCSS("font-size", "12px");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(pill.locator(".shimmer-text")).toHaveCSS("animation-name", "shimmer-text-slide");
});

test("conversation playback progresses through one thread and supports pause and replay", async ({ page }) => {
  await page.clock.install();
  await openStory(page, "design-foundations-typography--conversation-playback");
  const playback = page.getByTestId("conversation-playback");
  await expect(playback).toHaveAttribute("data-playback-state", "idle");
  await expect(page.getByRole("combobox", { name: "Thread preview state" })).toHaveCount(0);
  await playback.getByRole("button", { name: "Play conversation", exact: true }).click();
  await expect(playback.getByTestId("task-chat-human-bubble")).toHaveCount(1);
  await page.clock.runFor(2500);
  await expect(playback).toHaveAttribute("data-playback-stage", "1");
  await expect(playback.getByTestId("task-chat-live-run-pill")).toBeVisible();
  await playback.getByRole("button", { name: "Pause", exact: true }).click();
  const paused = await playback.innerText();
  await page.clock.runFor(5000);
  expect(await playback.innerText()).toBe(paused);
  await expect(playback).toHaveAttribute("data-playback-state", "paused");
  await playback.getByRole("button", { name: "Resume conversation", exact: true }).click();
  await page.clock.runFor(3000);
  await expect(playback).toHaveAttribute("data-playback-stage", "3");
  await expect(playback.getByTestId("task-chat-human-bubble")).toHaveCount(1);
  await expect(playback.getByText(/inspect the component alias/)).toBeVisible();
  const runningLabel = playback.locator('[data-conversation-tool-running="true"]').first();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(runningLabel).toHaveCSS("animation-name", "shimmer-text-slide");
  const foreground = await resolvedColor(playback, "--foreground");
  await expect(runningLabel).toHaveCSS("color", foreground);
  await page.clock.runFor(7500);
  await expect(playback).toHaveAttribute("data-playback-stage", "6");
  await expect(playback.locator('[data-conversation-text="final"] .paperclip-markdown').last()).toHaveCSS("color", foreground);
  await page.clock.runFor(7500);
  await expect(playback).toHaveAttribute("data-playback-stage", "9");
  await expect(playback.getByText("Which reconnect policy should I test?", { exact: true })).toBeVisible();
  await expect(playback.getByTestId("task-chat-human-bubble")).toHaveCount(2);
  await page.clock.runFor(11_000);
  await expect(playback).toHaveAttribute("data-playback-stage", "13");
  await expect(playback.locator('[data-conversation-tool-running="true"]')).toHaveCount(0);
  await page.clock.runFor(5000);
  await expect(playback).toHaveAttribute("data-playback-stage", "15");
  await expect(playback.locator('[data-conversation-tool-running="true"]').first()).toHaveCSS("animation-name", "shimmer-text-slide");
  await page.clock.runFor(10_000);
  await expect(playback).toHaveAttribute("data-playback-state", "complete");
  await expect(playback.getByTestId("task-chat-agent-bubble")).toHaveCount(2);
  await expect(playback.getByText("26 component source files", { exact: true })).toBeVisible();
  await playback.getByTestId("task-chat-turn-summary").last().click();
  await expect(playback.getByTestId("task-chat-activity-phase-toggle").first()).toBeVisible();
  await playback.getByRole("button", { name: "Replay conversation", exact: true }).click();
  await expect(playback).toHaveAttribute("data-playback-stage", "0");
  await expect(playback.getByTestId("task-chat-agent-bubble")).toHaveCount(0);
});


test("conversation metadata has hover and focus feedback and agent names stay body-sized", async ({ page }) => {
  await openStory(page, "design-foundations-typography--conversation-styles");
  const preview = page.getByTestId("sandbox-task-thread");
  const name = preview.getByTestId("task-chat-agent-identity").first().locator(":scope > span:last-child");
  await expect(name).toHaveCSS("font-size", "14px");
  await expect(name).toHaveCSS("line-height", "20px");
  await expect(name).toHaveCSS("font-weight", "600");
  const foreground = await resolvedColor(preview, "--foreground");
  await expect(name).toHaveCSS("color", foreground);
  const heading = preview.locator('[data-conversation-text="final"] h2').first();
  await expect(heading).toHaveCSS("font-size", "14px");
  await expect(heading).toHaveCSS("font-weight", "400");
  await expect(heading).toHaveCSS("color", foreground);
  const activity = preview.getByTestId("task-chat-turn-summary").first();
  const label = activity.locator("span").filter({ hasText: /^Activity$/ });
  const base = await label.evaluate(element => getComputedStyle(element).color);
  await activity.hover();
  await expect(label).toHaveCSS("color", foreground);
  await expect(activity).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.mouse.move(0, 0);
  await expect(label).toHaveCSS("color", base);
  await activity.focus();
  await expect(label).toHaveCSS("color", foreground);
  await expect(activity).toHaveCSS("font-size", "12px");
});

test("playback appends complete words with a fade while retaining previous word nodes", async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openStory(page, "design-foundations-typography--conversation-playback");
  const playback = page.getByTestId("conversation-playback");
  await playback.getByRole("button", { name: "Play conversation", exact: true }).click();
  await page.clock.runFor(3500);
  const prose = playback.locator('[data-conversation-text="progress"] .paperclip-markdown').last();
  const words = prose.locator(".conversation-stream-word");
  await expect(words.first()).toHaveText("I’ll");
  await expect(words.first()).toHaveCSS("animation-name", "conversation-word-in");
  await expect(words.first()).toHaveCSS("animation-duration", "0.32s");
  const initialCount = await words.count();
  const oldWord = await words.first().elementHandle();
  await page.clock.runFor(200);
  expect(await words.count()).toBeGreaterThan(initialCount);
  expect(await oldWord!.evaluate(element => element.isConnected)).toBe(true);
  const text = await prose.textContent();
  expect("I’ll inspect the component alias first, then check the file list. No code changes are needed.".startsWith(text!)).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(words.first()).toHaveCSS("animation-name", "none");
});

test("completion fades activity before folding its space and preserves the mounted answer", async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openStory(page, "design-foundations-typography--conversation-playback");
  const playback = page.getByTestId("conversation-playback");
  await playback.getByRole("button", { name: "Play conversation", exact: true }).click();
  await page.clock.runFor(15_800);
  const turn = playback.getByTestId("task-chat-turn-handoff").first();
  const activity = turn.getByTestId("task-chat-handoff-activity");
  const answer = turn.getByTestId("task-chat-agent-bubble");
  const node = await answer.elementHandle();
  const prose = await answer.locator("p").first().elementHandle();
  const before = await answer.boundingBox();
  const expandedHeight = (await activity.boundingBox())!.height;
  await page.clock.runFor(240);
  await expect(turn).toHaveAttribute("data-handoff-state", "settling");
  await expect(activity).toHaveAttribute("aria-hidden", "true");
  await expect(activity).toHaveAttribute("inert", "");
  await expect(activity).toHaveCSS("transition-delay", "0s, 0.18s");
  await expect(activity).toHaveCSS("transition-duration", "0.18s, 0.48s");
  expect(await node!.evaluate(element => element.isConnected)).toBe(true);
  expect(await prose!.evaluate(element => element.isConnected)).toBe(true);
  // Observe intermediate rendered geometry, not just a class name or endpoint.
  await expect.poll(async () => Number(await activity.evaluate(element => getComputedStyle(element).opacity))).toBeLessThan(1);
  await expect.poll(async () => (await activity.boundingBox())!.height).toBeLessThan(expandedHeight);
  await expect(turn).toHaveAttribute("data-handoff-state", "settled");
  expect((await activity.boundingBox())!.height).toBe(0);
  expect((await answer.boundingBox())!.y).toBeLessThan(before!.y);
  expect(await node!.evaluate(element => element.isConnected)).toBe(true);
  expect(await prose!.evaluate(element => element.isConnected)).toBe(true);
  await expect(turn.getByTestId("task-chat-turn-summary")).toBeVisible();
  await turn.getByTestId("task-chat-turn-summary").click();
  await expect(turn.getByTestId("task-chat-activity-phase-toggle").first()).toBeVisible();

  // Replay during an exit must discard its retained activity and old timers.
  await playback.getByRole("button", { name: "Replay", exact: true }).click();
  await page.clock.runFor(15_800);
  await page.clock.runFor(240);
  await expect(playback.getByTestId("task-chat-turn-handoff").first()).toHaveAttribute("data-handoff-state", "settling");
  await playback.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(playback.getByTestId("task-chat-turn-handoff")).toHaveCount(1);
  await expect(playback.getByTestId("task-chat-agent-bubble")).toHaveCount(0);
});

test("reduced motion settles the final response without an activity exit", async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openStory(page, "design-foundations-typography--conversation-playback");
  const playback = page.getByTestId("conversation-playback");
  await playback.getByRole("button", { name: "Play conversation", exact: true }).click();
  await page.clock.runFor(16_040);
  const turn = playback.getByTestId("task-chat-turn-handoff").first();
  await expect(turn).toHaveAttribute("data-handoff-state", "settled");
  await expect(turn.getByTestId("task-chat-handoff-activity")).toHaveCSS("transition-property", "none");
  await expect(turn.getByTestId("task-chat-turn-summary")).toBeVisible();
  await expect(turn.getByTestId("task-chat-live-run-pill")).toHaveCount(0);
});

test("one current item owns shimmer and startup plumbing stays out of the conversation", async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openStory(page, "design-foundations-typography--conversation-playback");
  const playback = page.getByTestId("conversation-playback");
  const owners = playback.locator('.shimmer-text, [data-conversation-tool-running="true"]');
  await playback.getByRole("button", { name: "Play conversation", exact: true }).click();
  await expect(owners).toHaveCount(1);
  await expect(owners).toHaveText("Working");
  await expect(playback).not.toContainText(/Preparing the turn|Preparing the transcript|Waiting for transcript|run phase:/i);
  await page.clock.runFor(1600);
  await expect(owners).toHaveCount(1);
  await expect(owners).toHaveText("Thinking");
  const working = playback.getByTestId("task-chat-live-run-pill").getByText("Working", { exact: true });
  const muted = await resolvedColor(playback, "--muted-foreground");
  await expect(working).toHaveCSS("color", muted);
  await expect(working).toHaveCSS("animation-name", "none");
  await page.clock.runFor(3800);
  await expect(owners).toHaveCount(1);
  await expect(owners).toHaveAttribute("data-conversation-tool-running", "true");
  await expect(owners).toHaveCSS("animation-name", "shimmer-text-slide");
  await expect(working).toHaveCSS("color", muted);
  await page.clock.runFor(7400);
  await expect(playback).toHaveAttribute("data-playback-stage", "6");
  await expect(owners).toHaveCount(0);
});

test("mixed-font tool text shares one uninterrupted shimmer loop", async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openStory(page, "design-foundations-typography--conversation-playback");
  const playback = page.getByTestId("conversation-playback");
  await playback.getByRole("button", { name: "Play conversation", exact: true }).click();
  await page.clock.runFor(9600);
  const line = playback.locator('[data-conversation-tool-running="true"]');
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("Running a command");
  await expect(line.locator("span").first()).toHaveCSS("font-family", /Inter/);
  await expect(line.locator("span").last()).toHaveCSS("font-family", /Paper Mono/);
  for (const child of await line.locator(":scope > span").all()) {
    await expect(child).toHaveCSS("animation-name", "none");
    await expect(child).toHaveCSS("background-image", "none");
    await expect(child).toHaveCSS("-webkit-text-fill-color", "rgba(0, 0, 0, 0)");
  }
  const sweep = await line.evaluate(element => {
    const animations = element.getAnimations({ subtree: true });
    const animation = animations.find(candidate => (candidate as CSSAnimation).animationName === "shimmer-text-slide")!;
    const timing = animation.effect!.getTiming();
    const keyframes = animation.effect!.getKeyframes();
    // Sample the old dead zone: the background must keep moving after 60%.
    animation.pause();
    animation.currentTime = Number(timing.duration) * 0.65;
    const first = getComputedStyle(element).backgroundPosition;
    animation.currentTime = Number(timing.duration) * 0.95;
    const second = getComputedStyle(element).backgroundPosition;
    animation.play();
    return { count: animations.length, easing: timing.easing, forever: timing.iterations === Infinity, offsets: keyframes.map(frame => frame.offset), first, second };
  });
  expect(sweep.count).toBe(1);
  expect(sweep.easing).toBe("linear");
  expect(sweep.forever).toBe(true);
  expect(sweep.offsets).toEqual([0, 1]);
  expect(sweep.first).not.toBe(sweep.second);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(line).toHaveCSS("animation-name", "none");
  await expect(line).toHaveCSS("background-image", "none");
  await expect(line.locator("span").last()).toHaveCSS("-webkit-text-fill-color", await resolvedColor(playback, "--foreground"));
});
