import { expect, it } from "vitest";
import { solicitsChatCredential, unsafeCredentialTransfer } from "./external-credential-language.js";

it("accepts secure-form entry that explicitly excludes chat", () => {
  expect(solicitsChatCredential("Enter your credential in the secure form, not in chat.")).toBe(false);
  expect(solicitsChatCredential("Enter your credential in the secure form.")).toBe(false);
});

it("retains positive and mixed chat destinations around a secure-form instruction", () => {
  for (const text of [
    "Enter your credential here in chat.",
    "Enter your credential in chat and in the secure form, not in messages.",
    "Enter your credential in the secure form, not in chat, or share it here.",
    "Enter your credential in the secure form, not in chat. Then send it here.",
    "Send your credential here. Enter your credential in the secure form, not in chat.",
    "Never share your credential. Then send it here in chat.",
  ]) expect(solicitsChatCredential(text), text).toBe(true);
});

it("keeps a later chat destination attached to the secure-entry imperative", () => {
  for (const conjunction of ["but", "then", "however"]) {
    expect(solicitsChatCredential(`Enter your personal publishing credential in the secure form, not in chat ${conjunction} here.`)).toBe(true);
  }
});
it("accepts the reported explicit chat exclusions and secure-target articles", () => {
  for (const text of [
    "Enter your personal publishing credential in the secure form, not in the chat.",
    "Enter your personal publishing credential in the secure form, and not in chat.",
    "Enter your personal publishing credential in the secure form, never in chat.",
    "Enter your personal publishing credential in the secure form, rather than in chat.",
    "Enter your personal publishing credential in your secure form, not in chat.",
  ]) expect(solicitsChatCredential(text), text).toBe(false);
});
it("does not let a warning negate a later positive imperative", () => {
  expect(solicitsChatCredential("Never share your credential but send the key here in chat.")).toBe(true);
});
it("keeps a safe chat exclusion when the follow-on clause is a settings instruction", () => {
  expect(solicitsChatCredential("Enter your credential in the secure form, not in chat but you can review it in settings.")).toBe(false);
});
it("does not carry a destination across a sentence or a negative prohibition", () => {
  expect(solicitsChatCredential("Enter your credential in the secure form, not in chat. Here.")).toBe(false);
  expect(solicitsChatCredential("Never enter your credential in the secure form, not in chat but here.")).toBe(false);
});
it("carries bare chat destinations from positive credential requests without requiring an exclusion", () => {
  expect(solicitsChatCredential("Enter your personal publishing credential in the secure form then in chat.")).toBe(true);
  expect(solicitsChatCredential("Send your credential then in chat.")).toBe(true);
  expect(solicitsChatCredential("Never send your credential then in chat.")).toBe(false);
  expect(solicitsChatCredential("Send your credential. In chat.")).toBe(false);
});

it("retains a subordinate verb inside the credential request", () => {
  expect(solicitsChatCredential("Please paste the credential you want to share here in chat.")).toBe(true);
});
it("retains the governing prohibition across coordinated verbs", () => {
  expect(solicitsChatCredential("You must never paste or share your credential here.")).toBe(false);
});

it("does not carry a prohibition across an explicit instead request", () => {
  expect(solicitsChatCredential("Do not paste your credential into files and instead send it here in chat.")).toBe(true);
});

it("keeps contrast normalization aligned with secure exemptions", () => {
  expect(solicitsChatCredential("Enter your credential in the secure form, not in chat and instead send a confirmation in settings.")).toBe(false);
});
it("resets a polite request at the same contrast boundary", () => {
  expect(solicitsChatCredential("Do not paste your credential into files and instead please send it here in chat.")).toBe(true);
});

it("retains an omitted credential object only for direct chat destinations", () => {
  expect(solicitsChatCredential("Send your key via secure form and instead share here in chat.")).toBe(true);
});
it("does not inherit a prior prohibition for an independent omitted-object request", () => {
  expect(solicitsChatCredential("Do not paste the credential into files but share here in chat.")).toBe(true);
});
it("retains an explicit noncredential object", () => {
  expect(solicitsChatCredential("Send your key via secure form and instead share progress here.")).toBe(false);
});

it("distinguishes an explicit message object from a credential destination", () => {
  expect(solicitsChatCredential("Enter your personal publishing credential in the secure form, not in chat. Share this message with Morgan.")).toBe(false);
  expect(solicitsChatCredential("Send your key via secure form and instead share in the chat.")).toBe(true);
});

it("resets an explicit request after a dash while retaining a plain prohibition", () => {
  for (const dash of ["—", "–", " - "]) {
    expect(solicitsChatCredential(`Do not paste your credential into files ${dash} send it here in chat.`)).toBe(true);
  }
  expect(solicitsChatCredential("You must never paste or share your credential here.")).toBe(false);
  expect(solicitsChatCredential("Do not paste your credential into files — keep it private.")).toBe(false);
});

it("separates secure entry from its dash-prefixed negative chat warning", () => {
  expect(solicitsChatCredential("Choose Set my value and enter your publishing key there — don't paste it in chat.")).toBe(false);
  expect(solicitsChatCredential("Choose Set my value and enter your publishing key there — paste it in chat.")).toBe(true);
});

it.each(["don't", "shouldn't", "mustn't", "can't", "couldn't", "won't", "wouldn't"])("keeps a contracted negative warning separate from a later request: %s", contraction => {
  for (const negative of [contraction, contraction.replace("'", "’")]) {
    const warning = `Choose Set my value and enter your publishing key there — ${negative} paste it in chat.`;
    expect(solicitsChatCredential(warning), warning).toBe(false);
    expect(solicitsChatCredential(`${warning} But share it here in chat.`)).toBe(true);
  }
});
it("keeps ever within a negative warning without extending it across contrast", () => {
  expect(solicitsChatCredential("Choose Set my value and enter your publishing key there — don't ever paste it in chat.")).toBe(false);
  expect(solicitsChatCredential("Don't ever paste your key in files — send it here in chat.")).toBe(true);
});
it("does not let a prohibition mask an independent comma-conjoined request", () => {
  for (const politeness of ["", "please "]) expect(solicitsChatCredential(`Don't ever paste your key in files, and ${politeness}send it here in chat.`)).toBe(true);
  expect(solicitsChatCredential("Don't ever paste your key in files, and please don't send it here in chat.")).toBe(false);
});
it("normalizes cannot in a warning without masking a later positive request", () => {
  const warning="Choose Set my value and enter your publishing key there — you cannot paste it in chat.";
  expect(solicitsChatCredential(warning)).toBe(false);
  expect(solicitsChatCredential(`${warning} But send it here in chat.`)).toBe(true);
});

it("separates a directly negated chat destination from secure entry", () => {
  expect(solicitsChatCredential("Enter and save the key there — not here in chat.")).toBe(false);
  expect(solicitsChatCredential("Enter the key in Settings — then paste it here in chat.")).toBe(true);
  expect(solicitsChatCredential("Enter your key here in chat — not in the secure form.")).toBe(true);
});

it("retains the entry request after an excluded destination before a positive destination", () => {
  expect(solicitsChatCredential("Enter your personal publishing credential in the secure form — not here, but in chat.")).toBe(true);
});

const securePageHandoff = "Open Settings → Secrets and choose New secret, then enter the value on that page (not in chat).";
it.each([
  securePageHandoff,
  "Morgan is set up, but there is no deployment key in the company secret store yet — only `openrouter_api_key` exists. I can't create or receive secret values; company secrets use board-only secure entry. Please add it at **Company settings → Secrets** (company-prefixed `/company/settings/secrets`) via **New secret**: name it `Deployment API Key`, key `DEPLOY_API_KEY`, and enter the value on that page (not in chat).\n\nOnce it's saved, tell me and confirm the env var Morgan should receive. I'll bind that secret reference into Morgan's environment (default `DEPLOY_API_KEY`) and verify it resolves before Morgan uses it.",
])("accepts secure-page entry with a local parenthetical chat exclusion", text => {
  expect(solicitsChatCredential(text)).toBe(false);
  expect(unsafeCredentialTransfer(text)).toBe(false);
});
it("keeps independent unsafe transfers after a secure-page exclusion", () => {
  for (const request of ["Then send the key here in chat.", "Then email the key to Morgan.", "Then write the key in a shell command.", "Then send the key to Riley."]) {
    const text = `${securePageHandoff} ${request}`;
    expect(unsafeCredentialTransfer(text), text).toBe(true);
  }
  expect(solicitsChatCredential(`${securePageHandoff} Then send the key here in chat.`)).toBe(true);
  expect(unsafeCredentialTransfer("Open Settings → Secrets, then enter the key in a plaintext file (not in chat).")).toBe(true);
  expect(unsafeCredentialTransfer("Enter the key on that page (not in chat).")).toBe(true);
  expect(unsafeCredentialTransfer(`${securePageHandoff} Then tell me the saved key name.`)).toBe(false);
});
it("distinguishes an explicit reference from a value or a mixed credential object",()=>{
 expect(unsafeCredentialTransfer("Use secure Settings Secrets to save the deployment key. Then enter the secret reference in Morgan's environment.")).toBe(false);
 expect(unsafeCredentialTransfer("Enter the secret reference and value here in chat.")).toBe(true);
 expect(unsafeCredentialTransfer("Enter the secret reference and key here in chat.")).toBe(true);
});
it("starts independent comma requests without carrying a prior prohibition",()=>{
 for(const separator of [", just ",", and ",", now "])expect(unsafeCredentialTransfer(`Do not paste the key in chat${separator}email the key to Morgan.`)).toBe(true);
 expect(unsafeCredentialTransfer("Do not paste the key in chat, or enter the key in plaintext files.")).toBe(false);
 expect(unsafeCredentialTransfer("Do not paste the key in chat, and do not email the key to Morgan.")).toBe(false);
 expect(unsafeCredentialTransfer("Do not paste the key in chat, or enter it in files but instead email the key to Morgan.")).toBe(true);
});

it("keeps a deictic value destination tied to the nearest supported page",()=>{
 for(const text of [
  "Open Settings → Secrets, New secret. Open a public wiki page and enter the key on that page (not in chat). After saving, I will bind the deployment secret reference to Morgan's environment.",
  "Open Settings → Secrets, then open a public wiki page and enter the key on that page (not in chat).",
 ])expect(unsafeCredentialTransfer(text),text).toBe(true);
 expect(unsafeCredentialTransfer(securePageHandoff)).toBe(false);
});
