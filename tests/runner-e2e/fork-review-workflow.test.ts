import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("keeps fork PR review read-only and executes only the reviewed base without the upstream private bot", () => {
  const workflow = parse(readFileSync(new URL("../../.github/workflows/commitperclip-review.yml", import.meta.url), "utf8"));
  expect(workflow.on.pull_request_target).toBeDefined();
  expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "read" });
  expect(workflow.jobs.review.if).toBe("github.repository == 'paperclipai/paperclip'");
  const fork = workflow.jobs["fork-review"];
  expect(fork.if).toBe("github.repository != 'paperclipai/paperclip'");
  expect(fork.permissions).toBeUndefined();
  expect(JSON.stringify(fork)).not.toContain("secrets.");
  const checkout = fork.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"));
  expect(checkout.with).toEqual({ ref: "${{ github.event.pull_request.base.sha }}", "persist-credentials": false });
  expect(fork.steps.some((step: { uses?: string }) => step.uses?.startsWith("actions/dependency-review-action@"))).toBe(true);
  const scripts = fork.steps.filter((step: { run?: string }) => step.run);
  expect(scripts).toHaveLength(1);
  expect(scripts[0].run).toBe("node .github/scripts/check-pr-template.mjs");
  expect(scripts[0].env.PR_BODY).toBe("${{ github.event.pull_request.body }}");
});
