import { t } from "@/i18n";
import { describeError, type ErrorDescription } from "@/api/errors";

/** Explicit first-party presentation, never inferred from a stored string. */
export interface UiMessageDescriptor {
  key: string;
  values?: Record<string, string | number>;
}

export interface ToastPresentation {
  /** Explicit first-party composite copy; never inferred from arbitrary getters. */
  render?: () => { title: string; body?: string; action?: string };
  error?: { cause: unknown; action?: UiMessageDescriptor };
  title?: UiMessageDescriptor;
  body?: UiMessageDescriptor;
  action?: UiMessageDescriptor;
}

export function resolveUiMessage(message: UiMessageDescriptor): string {
  return t(message.key, message.values);
}

// Local first-party throw sites opt in by identity, not Error.message. This is
// separate from generic API provenance and never writes properties on errors.
const localErrorMessages = new WeakMap<Error, UiMessageDescriptor>();

export function localizeUiError<T extends Error>(error: T, message: UiMessageDescriptor): T {
  localErrorMessages.set(error, message);
  return error;
}

export function uiErrorDescriptor(error: unknown): UiMessageDescriptor | undefined {
  return error instanceof Error ? localErrorMessages.get(error) : undefined;
}

export function describeUiError(error: unknown, action?: UiMessageDescriptor): ErrorDescription {
  const description = describeError(error, { action: action ? resolveUiMessage(action) : undefined });
  const message = uiErrorDescriptor(error);
  return message ? { ...description, body: resolveUiMessage(message) } : description;
}
