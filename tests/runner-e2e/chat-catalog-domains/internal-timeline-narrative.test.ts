import { expect, it } from "vitest";
import { truthfulTimelineAccount } from "./internal-timeline-narrative.js";

const account = `**First attempt (Morgan)**
Morgan built the page. The verification command failed with exit 1. Morgan reported the task as blocked.

**Repair (Riley)**
You reassigned the task to Riley. He added \`<label for="email">Email address</label>\`, preserved the heading, and verification exited 0.`;
const grade = (reply: string) => truthfulTimelineAccount({ reply, firstWorker: "Morgan", repairWorker: "Riley" });
it("resolves a named section's command and pronoun without requiring repeated names", () => {
  expect(grade(account)).toBe(true);
});
it.each([
  account.replace("You reassigned the task to Riley. ", ""),
  account.replace("You reassigned", "Morgan reassigned"),
  account.replace("He added", "Morgan added"),
  account.replace("First attempt (Morgan)", "First attempt (Riley)"),
  account + " A native run failed.",
  account.replace("verification exited 0", "verification exited 1"),
])("retains consequential actor and outcome requirements: %s", reply => {
  expect(grade(reply)).toBe(false);
});
it("does not carry a section owner through an unrelated paragraph", () => {
  expect(grade(account.replace("The verification", "\n\nThe verification"))).toBe(false);
});

it("does not give a heading credit for another actor's command", () => {
  expect(grade(account.replace("The verification command failed", "The human operator ran verification and it failed"))).toBe(false);
});

it("accepts a transition before a command subject", () => {
  expect(grade(account.replace("The verification", "Then the verification"))).toBe(true);
});
it("resolves the first subject after the worker heading", () => {
  expect(grade(account.replace("**Repair (Riley)**\nYou reassigned the task to Riley. He", "You reassigned the task to Riley.\n\n**Repair (Riley)**\nHe"))).toBe(true);
});
it.each([
  account.replace("You reassigned the task to Riley. He", "You reassigned the task to Riley. Avery inspected the page. He"),
  account.replace("You reassigned the task to Riley. He", "You reassigned the task to Riley. The human operator inspected the page. He"),
  account.replace("The verification command failed", "The verification command that Avery ran failed"),
])("does not resolve another actor through a heading: %s", reply => {
  expect(grade(reply)).toBe(false);
});

it("does not treat a weekday in a command result as an actor", () => {
  expect(grade(account.replace("failed with exit 1", "failed on Tuesday with exit 1"))).toBe(true);
});
it("retains the safely resolved subject across consecutive pronouns", () => {
  expect(grade(account.replace("He added", "He preserved the heading. He added"))).toBe(true);
});
