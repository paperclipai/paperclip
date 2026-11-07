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
  "I declined the request. In this chat, I have saved a draft for your review.",
  "I declined the request. If you would like the proposal I have written for your review, approve a new request in the notes app.",
  "I declined the request. I wrote a proposal for your review. If approved, it can be saved in the notes app.",
  "You declined. Once approved, the update will be applied.",
  "You declined. When approved, the update can be applied.",
  "You declined. Nothing was added or saved.",
  "You declined. Nothing was added and saved.",
  "You declined. No update was written or saved.",
  "You declined. The draft was saved in this chat for your review.",
  "You declined. The draft is saved locally for your review.",
  "You declined. The drafts are saved locally for your review.",
  "You declined. The draft was saved (in this chat) for your review.",
  "You declined. Nothing was saved, except a draft in this chat for your review.",
  "You declined. In this chat, nothing was saved, except a draft for your review.",
  "You declined. Nothing was saved, except a draft saved locally for your review.",
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
  "You declined. Nothing was added or saved, except the draft in the notes app.",
  "You declined. No changes were saved, except the update in the notes app.",
  "You declined. I applied no changes, except the update in the notes app.",
  "You declined. I saved a draft for your review.",
  "You declined. The draft is saved remotely for your review.",
  "You declined. Once approved, I already applied the update.",
  "You declined. Nothing was added, but I saved the changes.",
  "You declined. Nothing was added and I already saved the notes.",
  "You declined. Nothing was added and I saved the page.",
  "I declined the request. In the notes app, I have saved a draft for your review.",
  "I declined the request. I have, in the notes app, saved a draft for your review.",
  "I declined the request. I have (in the notes app) saved a draft for your review.",
  "I declined the request. On the external page, a draft was written for your review.",
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

const negations = ["No changes were saved", "Nothing was added or saved", "I applied no changes"];
const exceptionForms = [
  { form: "direct", local: "a draft in this chat for your review", external: "a draft in the notes app for your review", unknown: "a draft for your review" },
  { form: "participle", local: "a draft saved locally for your review", external: "a draft saved in the notes app for your review", unknown: "a draft saved for your review" },
  { form: "relative", local: "a draft I have saved in this chat for your review", external: "a draft I have saved in the notes app for your review", unknown: "a draft I have saved for your review" },
  { form: "auxiliary", local: "a draft that was written in this response for your review", external: "a draft that was written in the notes app for your review", unknown: "a draft that was written for your review" },
];
const exceptionScopes = exceptionForms.flatMap(form => (["local", "external", "unknown"] as const).map(scope => ({ form: form.form, object: form[scope], accepted: scope === "local" })));
it.each(negations.flatMap(negation => exceptionScopes.map(scope => ({ negation, ...scope }))))(
  "scopes $negation to the $form exception: $object", ({ negation, object, accepted }) => {
    expect(reviewOutcomeReply(`You declined. ${negation}, except ${object}.`, "rejected")).toBe(accepted);
  },
);
it.each(negations.flatMap(negation => exceptionForms.map(form => ({ negation, object: form.local }))))(
  "does not stop scanning after $negation except $object", ({ negation, object }) => {
    expect(reviewOutcomeReply(`You declined. ${negation}, except ${object}. I already applied the update in the notes app.`, "rejected")).toBe(false);
  },
);
it("rejects a local-looking exception that also names an external saved destination", () => {
  expect(reviewOutcomeReply("You declined. Nothing was saved, except a draft in this chat for your review in the notes app.", "rejected")).toBe(false);
});

it.each([
  "You declined. Nothing was saved, except a draft saved locally for your review in the notes app.",
  "You declined. Nothing was saved, except a draft that I have saved in the notes app for your review.",
  "You declined. Nothing was saved, except a draft I already applied in the notes app for your review.",
])("rejects a mixed or nested external exception: %s", reply => {
  expect(reviewOutcomeReply(reply, "rejected")).toBe(false);
});

it.each(["**not**", "__not__", "*not*", "_not_", "***not***", "___not___"])(
  "reads paired emphasis around negation as visible prose: %s", negation => {
    expect(reviewOutcomeReply(`You declined. The update was ${negation} applied.`, "rejected")).toBe(true);
  },
);
it.each([
  "You declined. I **applied** the update.",
  "You declined. The update was __applied__.",
  "You declined. I *saved* the update in the notes app.",
  "You declined. The update was **not** applied, but I **saved** it to the notes app.",
  "You declined. Nothing was **saved**, but I **applied** the update.",
  "You declined. The draft was saved **in the notes app** for your review.",
])("paired emphasis does not hide external completion: %s", reply => {
  expect(reviewOutcomeReply(reply, "rejected")).toBe(false);
});
it.each([
  "You declined. The update was not** applied.",
  String.raw`You declined. The update was \**not** applied.`,
])("does not strip unmatched or escaped emphasis markers: %s", reply => {
  expect(reviewOutcomeReply(reply, "rejected")).toBe(false);
});
