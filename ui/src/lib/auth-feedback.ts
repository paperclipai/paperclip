export type AuthMode = "sign_in" | "sign_up";

export type AuthFeedback = {
  tone: "error" | "info";
  message: string;
};

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim().length > 0 ? code.trim() : null;
}

function readErrorMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const message = error.message.trim();
  return message.length > 0 ? message : null;
}

function readErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

export function isInvalidCredentialsError(error: unknown): boolean {
  const code = readErrorCode(error);
  const status = readErrorStatus(error);
  return code === "INVALID_EMAIL_OR_PASSWORD" || status === 401;
}

export function isExistingAccountConflict(error: unknown): boolean {
  const code = readErrorCode(error);
  const status = readErrorStatus(error);
  return code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" || status === 422;
}

export function formatAuthFeedback(
  error: unknown,
  authMode: AuthMode,
  options?: {
    emailLabel?: string;
    inviteContext?: boolean;
  },
): AuthFeedback {
  const message = readErrorMessage(error);
  const emailLabel = options?.emailLabel?.trim().length ? options.emailLabel.trim() : "that email";
  const inviteContext = options?.inviteContext ?? false;

  if (authMode === "sign_in" && isInvalidCredentialsError(error)) {
    return {
      tone: "error",
      message: inviteContext
        ? "That email and password did not match an existing Paperclip account. Check both fields, or create an account first if you are new here."
        : "That email and password did not match a Paperclip account. Check both fields, or create an account if you are new here.",
    };
  }

  if (authMode === "sign_up" && isExistingAccountConflict(error)) {
    return {
      tone: "info",
      message: inviteContext
        ? `An account already exists for ${emailLabel}. Sign in below to continue with this invite.`
        : `An account already exists for ${emailLabel}. Sign in instead.`,
    };
  }

  return {
    tone: "error",
    message: message ?? "Authentication failed. Check your details and try again.",
  };
}
