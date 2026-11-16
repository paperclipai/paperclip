import { expect, it } from "vitest";
import { hasLink } from "./internal-support.js";
import type { InternalObservation } from "./internal-support.js";

const origin = "http://127.0.0.1:3100";
const task = { id: "8d3f0c1e-0000-4000-8000-000000000001", identifier: "COM-5", title: "Automated maintenance" };
const observed = (links: string[]) => ({ origin, links } as unknown as InternalObservation);

it("links a task only through its own id, identifier or url key", () => {
  expect(hasLink(observed(["/COM/issues/COM-5"]), "issues", task)).toBe(true);
  expect(hasLink(observed([`/COM/issues/${task.id}`]), "issues", task)).toBe(true);
  expect(hasLink(observed(["/COM/issues/COM-6"]), "issues", task)).toBe(false);
});

it("does not treat a list or filtered view as a link to every task without a url key", () => {
  expect(hasLink(observed(["/COM/issues?view=mine"]), "issues", task)).toBe(false);
  expect(hasLink(observed(["/COM/issues"]), "issues", task)).toBe(false);
  expect(hasLink(observed(["/COM/issues/"]), "issues", task)).toBe(false);
});
