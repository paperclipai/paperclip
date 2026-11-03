import { expect, it } from "vitest";
import { reviewOutcomeReply } from "./external-app-review.js";

it.each([
  "You declined. If you'd like it applied, approve a new request.",
  "The request was rejected. If you want the edit applied, approve a new request.",
  "You declined. If you would like the proposal I have written for your review, approve a new request.",
  "You declined. I wrote a proposal for your review. It has not been applied.",
  "You declined. The proposal was written for your review. No external update was made.",
  "I declined the request. If I applied the update, it would change the page.",
  "I declined the request. I applied no changes.",
  "Nothing was changed. You declined; you can approve a future request.",
  "You declined. If you would like the draft saved locally for your review applied, approve a new request.",
])("accepts a truthful declined outcome: %s", reply => {
  expect(reviewOutcomeReply(reply, "rejected")).toBe(true);
});

it.each([
  "You declined. I applied the update.",
  "You declined. If you want the edit I already applied, approve a new request.",
  "You declined. If you would like the draft I have saved in the notes app, approve a new request.",
  "You declined. I saved the proposal for review in the notes app.",
  "You declined. If you want it applied, approve a new request. I already wrote it to the page.",
  "You declined. The update was applied.",
  "You declined. The action has been completed.",
  "You declined. I approved the request.",
  "You declined. Applied the requested edit.",
  "You declined. I did not write a note because I already applied the edit.",
  "You declined. The update succeeded.",
  "I declined the request. Your changes have been applied.",
  "I declined the request. It has now been applied.",
  "I declined the request. The notes were saved.",
  "You declined. The draft was saved in the notes app.",
  "You declined. I’ve updated the page.",
  "You declined. It’s been applied.",
  "You declined. I’m done applying the update.",
  "You declined. I have saved a proposal for your review in Notion.",
  "You declined. If you want the proposal I have saved for your review, in Notion, approve a new request.",
])("rejects an external accomplishment claim: %s", reply => {
  expect(reviewOutcomeReply(reply, "rejected")).toBe(false);
});

it("still requires an actual rejection statement", () => {
  expect(reviewOutcomeReply("If you'd like it applied, approve a new request.", "rejected")).toBe(false);
});
