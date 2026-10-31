import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "../../ui/node_modules/vite/dist/node/index.js";
import { answerResumeQuestionThroughUi } from "./question-resume-ui.js";
import { chatQuestionPresentation } from "./chat-flow.js";

let server: ViteDevServer;
let origin: string;
const uiRoot = path.resolve(import.meta.dirname, "../../ui");
const probe = path.join(uiRoot, "src/__question_resume_probe.tsx");

test.beforeAll(async () => {
  server = await createServer({
    root: uiRoot, configFile: false,
    resolve: { alias: { "@": path.join(uiRoot, "src") } },
    oxc: { jsx: { runtime: "automatic" } },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "question-resume-controls",
      resolveId(id: string) { if (id === "/src/__question_resume_probe.tsx") return probe; },
      load(id: string) {
        if (id !== probe) return;
        return `import React from "react";
          import { createRoot } from "react-dom/client";
          import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
          import { QuestionForm } from "/src/components/task-chat/QuestionForm.tsx";
          const root = createRoot(document.getElementById("root"));
          const client = new QueryClient();
          window.showQuestion = questionSet => root.render(<QueryClientProvider client={client}>
            <QuestionForm id="reference" questionSet={questionSet} onSubmit={response => { window.submitted = response; }} />
          </QueryClientProvider>);`;
      },
      configureServer(vite: ViteDevServer) {
        vite.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
          if (req.url !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<div id="root"></div><script type="module" src="/src/__question_resume_probe.tsx"></script>');
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });

for (const mode of ["text", "single_select"] as const) {
  test(`submits an exact typed reference through the real ${mode} QuestionForm control`, async ({ page }) => {
    const field = { id: "reference", prompt: "What reference should I include?", required: true, answerMode: mode,
      ...(mode === "single_select" ? { options: [{ id: "none", label: "No reference" }], customAnswer: { enabled: true, label: "Write reference" } } : {}) };
    const card = { payload: { questionSet: { schema: "paperclip.question_set.v1", questions: [field] } } };
    await page.goto(origin);
    await page.waitForFunction(() => typeof (window as any).showQuestion === "function");
    await page.evaluate(set => (window as any).showQuestion(set), card.payload.questionSet);
    if (mode === "single_select") await page.getByRole("radio", { name: "No reference", exact: true }).click();
    await answerResumeQuestionThroughUi(page, card, { text: "Use AMBERwritten.", allowProviderCustomAnswer: true });
    expect(await page.evaluate(() => (window as any).submitted)).toEqual({
      schema: "paperclip.question_response.v1", answers: { reference: mode === "text"
        ? { text: "Use AMBERwritten." } : { selectedOptionIds: [], customText: "Use AMBERwritten." } },
    });
    if (mode === "single_select") await expect(page.getByRole("radio", { name: "No reference", exact: true })).toHaveAttribute("aria-checked", "false");
  });
}

for (const invalid of ["missing", "disabled", "legacy", "strict"] as const) {
  test(`does not infer a written-answer capability from ${invalid} metadata`, async ({ page }) => {
    const field = { id: "reference", prompt: "Reference?", answerMode: "single_select", options: [{ id: "none", label: "No reference" }],
      ...(invalid === "missing" ? {} : { customAnswer: { enabled: invalid !== "disabled" } }) };
    const card = { payload: invalid === "legacy" ? { questions: [{ ...field, options: [{ id: "none", label: "No reference", freeText: true }] }] }
      : { questionSet: { schema: "paperclip.question_set.v1", questions: [field] } } };
    await page.goto(origin);
    await page.waitForFunction(() => typeof (window as any).showQuestion === "function");
    const set = invalid === "legacy" ? chatQuestionPresentation(card.payload as any) : card.payload.questionSet;
    await page.evaluate(set => (window as any).showQuestion(set), set);
    await expect(page.getByRole("radio", { name: "No reference", exact: true })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Other", exact: true })).toHaveCount(invalid === "strict" ? 1 : 0);
    await expect(answerResumeQuestionThroughUi(page, card, { text: "Use AMBERwritten.", ...(invalid === "strict" ? {} : { allowProviderCustomAnswer: true }) })).rejects.toThrow();
    expect(await page.evaluate(() => (window as any).submitted)).toBeUndefined();
  });
}
