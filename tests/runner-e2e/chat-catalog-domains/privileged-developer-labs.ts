import { expect } from "@playwright/test";
import type { Request } from "@playwright/test";
import { checks } from "./internal-support.js";
import { privilegedDefinition, privilegedObservation, settlePrivilegedChat } from "./privileged-support.js";

function fixtureBoundary(reply: string) {
  const positive = reply.replace(/\b(?:not|isn't|does not|cannot|can't)\b[^.!?\n]*/gi, "");
  return /synthetic|fixture|design reference|presentation|storybook|mock/i.test(reply)
    && !/not\s+(?:a\s+)?(?:synthetic|fixture|mock)/i.test(reply)
    && !/real\s+(?:authorization|continuation)\s+proof|(?:verified|proved|confirmed).{0,35}(?:real|live|production).{0,25}(?:authorization|denial|continuation|workflow)/i.test(positive);
}
export function gradeComponentReference(value: unknown) {
  const c = checks(), o = privilegedObservation(value);
  c.add("component-observation", !!o, "Actual browser state transitions and the run-attributed canonical reply are required."); if (!o) return c.result();
  c.add("existing-question-reference", /design-guide|DesignGuide|TaskPendingInputExample|TaskChatComposer|storybook/i.test(o.reply)
    && /question|decision|pending input/i.test(o.reply) && /dismiss|reopen|resolv|answer|pending/i.test(o.reply),
    "The reply identifies an existing design or Storybook question example and relevant states.");
  c.add("question-states-opened", typeof o.state.referencePath === "string" && /^\/[^/]+\/design-guide$/.test(o.state.referencePath)
    && o.state.referenceCompanyId === o.companyId && o.state.questionVisible === true
    && o.state.questionDismissed === true && o.state.questionReopened === true && o.state.questionResolved === true,
    "The actual supported design guide renders the question and its dismiss, reopen and resolution states.");
  c.add("reference-only", fixtureBoundary(o.reply) && o.state.fixtureMutations === 0 && o.state.beforeRuns === o.state.afterRuns,
    "The fixture does not perform API mutations or admit native work; rendering is not authorization or continuation proof.");
  return c.result();
}
export function gradeInteractionFixture(value: unknown) {
  const c = checks(), o = privilegedObservation(value);
  c.add("denial-presentation-observation", !!o, "A real browser must display the existing synthetic denial surface."); if (!o) return c.result();
  c.add("existing-denial-lab-guidance", /responsible-user-denial|ResponsibleUserDenialUxLab|denial.{0,30}(?:lab|fixture)|(?:lab|fixture).{0,30}denial/i.test(o.reply)
    && fixtureBoundary(o.reply), "The response identifies the existing denial lab and explains its synthetic limitation.");
  c.add("denial-and-action-rendered", o.state.referencePath === "/ux-lab/responsible-user-denial"
    && o.state.denialVisible === true && o.state.denialActionVisible === true && o.state.unavailableStateVisible === true,
    "The actual denial notice displays both the blocked action and the supported human recovery guidance.");
  c.add("no-real-tool-call", o.state.fixtureMutations === 0 && o.state.beforeRuns === o.state.afterRuns,
    "Opening this presentation fixture issues no mutation and admits no real model/tool work.");
  return c.result();
}

/** No fixture data is inserted into the conversation or substituted for model output. */
export const privilegedDeveloperLabCases = [
  privilegedDefinition("developer-labs.component-reference", "privileged-developer-labs", {
    async setup() { return {}; }, grade: gradeComponentReference,
    async act(ctx, state) {
      await settlePrivilegedChat(ctx);
      const source = ctx.input.page.url(), page = ctx.input.page;
      let writes = 0; const observe = (request: Request) => { if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes++; };
      state.beforeRuns = (await ctx.allRuns()).length;
      page.on("request", observe);
      try {
        await page.goto(new URL(`/${ctx.input.fixtures.company.issuePrefix}/design-guide`, ctx.input.api.baseURL).href, { waitUntil: "domcontentloaded" });
        const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Pending task input above composer", exact: true }) });
        await expect(section.getByText("Should the agent use the existing draft?", { exact: true })).toBeVisible(); state.questionVisible = true;
        await ctx.input.capture("question-component-open", "Synthetic question card open", "question-component-open.png");
        await section.getByRole("button", { name: "Dismiss Question", exact: true }).click();
        await expect(section.getByTestId("task-chat-composer-takeover")).toHaveCount(0); state.questionDismissed = true;
        await section.getByTestId("task-chat-pending-input-indicator").click();
        await expect(section.getByText("Should the agent use the existing draft?", { exact: true })).toBeVisible(); state.questionReopened = true;
        await section.getByRole("button", { name: "Use draft", exact: true }).click();
        await expect(section.getByTestId("task-chat-composer-takeover")).toHaveCount(0);
        await expect(section.getByTestId("task-chat-pending-input-indicator")).toHaveCount(0); state.questionResolved = true;
        state.referencePath = new URL(page.url()).pathname;
        state.referenceCompanyId = ctx.input.fixtures.company.id;
        await ctx.input.capture("question-component-reference", "Synthetic question card reference states", "question-component-reference.png");
      } finally { page.off("request", observe); state.fixtureMutations = writes; await page.goto(source, { waitUntil: "domcontentloaded" }); }
      state.afterRuns = (await ctx.allRuns()).length;
      await ctx.input.evidence("chat-catalog-question-reference.json", { ...state, scope: "presentation-only; no authorization or continuation proof" });
    },
    async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
  }),
  privilegedDefinition("developer-labs.interaction-fixture", "privileged-developer-labs", {
    async setup() { return {}; }, grade: gradeInteractionFixture,
    async act(ctx, state) {
      await settlePrivilegedChat(ctx);
      const page = ctx.input.page, source = page.url(); let writes = 0;
      const observe = (request: Request) => { if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes++; };
      state.beforeRuns = (await ctx.allRuns()).length; page.on("request", observe);
      try {
        await page.goto(new URL("/ux-lab/responsible-user-denial", ctx.input.api.baseURL).href, { waitUntil: "domcontentloaded" });
        const denial = page.locator('[data-testid="responsible-user-denial-notice"][data-denial-code="RESPONSIBLE_USER_UNAUTHORIZED"]').first();
        await expect(denial.getByText("Responsible user not authorized", { exact: true })).toBeVisible(); state.denialVisible = true;
        await expect(denial).toContainText("have someone who is authorized take this action instead"); state.denialActionVisible = true;
        await expect(page.locator('[data-denial-code="RESPONSIBLE_USER_UNAVAILABLE"]').first()).toContainText("Mark the work blocked"); state.unavailableStateVisible = true;
        state.referencePath = new URL(page.url()).pathname;
        await ctx.input.capture("synthetic-denial-reference", "Synthetic denial and human action guidance", "synthetic-denial-reference.png");
      } finally { page.off("request", observe); state.fixtureMutations = writes; await page.goto(source, { waitUntil: "domcontentloaded" }); }
      state.afterRuns = (await ctx.allRuns()).length;
      await ctx.input.evidence("chat-catalog-denial-reference.json", { ...state, scope: "presentation-only; no real provider denial" });
    },
    async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
  }),
];
for (const definition of privilegedDeveloperLabCases) definition.sourceFiles = [...definition.sourceFiles,
  "../../ui/src/App.tsx", "../../ui/src/pages/DesignGuide.tsx", "../../ui/src/pages/ResponsibleUserDenialUxLab.tsx"];
