import { describe, expect, it } from "vitest";
import { formatAuthFeedback } from "./auth-feedback";

describe("formatAuthFeedback", () => {
  // ── CLI-200 regression: auth/sign-in error messages ──────────────────────

  it("maps sign-in failures to actionable copy (code path)", () => {
    const feedback = formatAuthFeedback(
      Object.assign(new Error("Invalid email or password"), {
        code: "INVALID_EMAIL_OR_PASSWORD",
        status: 401,
      }),
      "sign_in",
    );

    expect(feedback).toEqual({
      tone: "error",
      message: "That email and password did not match a Paperclip account. Check both fields, or create an account if you are new here.",
    });
  });

  it("maps sign-in failures when only HTTP 401 status is present (no code)", () => {
    const feedback = formatAuthFeedback(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
      "sign_in",
    );

    expect(feedback).toEqual({
      tone: "error",
      message: "That email and password did not match a Paperclip account. Check both fields, or create an account if you are new here.",
    });
  });

  it("maps sign-up conflicts to actionable copy (code path)", () => {
    const feedback = formatAuthFeedback(
      Object.assign(new Error("User already exists"), {
        code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
        status: 422,
      }),
      "sign_up",
    );

    expect(feedback).toEqual({
      tone: "info",
      message: "An account already exists for that email. Sign in instead.",
    });
  });

  it("maps sign-up conflicts when only HTTP 422 status is present (no code)", () => {
    const feedback = formatAuthFeedback(
      Object.assign(new Error("Unprocessable"), { status: 422 }),
      "sign_up",
    );

    expect(feedback).toEqual({
      tone: "info",
      message: "An account already exists for that email. Sign in instead.",
    });
  });

  it("keeps invite-specific guidance for invite sign-in failures", () => {
    const feedback = formatAuthFeedback(
      Object.assign(new Error("Request failed: 401"), { status: 401 }),
      "sign_in",
      { emailLabel: "jane@example.com", inviteContext: true },
    );

    expect(feedback).toEqual({
      tone: "error",
      message: "That email and password did not match an existing Paperclip account. Check both fields, or create an account first if you are new here.",
    });
  });

  it("keeps invite-specific guidance for invite sign-up conflicts", () => {
    const feedback = formatAuthFeedback(
      Object.assign(new Error("Request failed: 422"), { status: 422 }),
      "sign_up",
      { emailLabel: "jane@example.com", inviteContext: true },
    );

    expect(feedback).toEqual({
      tone: "info",
      message: "An account already exists for jane@example.com. Sign in below to continue with this invite.",
    });
  });

  it("falls back to 'that email' when emailLabel is blank in invite sign-up conflict", () => {
    const feedback = formatAuthFeedback(
      Object.assign(new Error("Conflict"), { status: 422 }),
      "sign_up",
      { emailLabel: "   ", inviteContext: true },
    );

    expect(feedback).toEqual({
      tone: "info",
      message: "An account already exists for that email. Sign in below to continue with this invite.",
    });
  });

  it("falls through to the error message when it is set and no known code/status matches", () => {
    const feedback = formatAuthFeedback(
      new Error("Custom auth failure from provider"),
      "sign_in",
    );

    expect(feedback).toEqual({
      tone: "error",
      message: "Custom auth failure from provider",
    });
  });

  it("falls back to generic copy when error has no message and no known code/status", () => {
    const feedback = formatAuthFeedback(
      Object.assign(new Error(""), { status: 500 }),
      "sign_in",
    );

    expect(feedback).toEqual({
      tone: "error",
      message: "Authentication failed. Check your details and try again.",
    });
  });
});
