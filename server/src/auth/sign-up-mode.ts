import { AUTH_SIGN_UP_MODES, type AuthSignUpMode } from "@paperclipai/shared";

export const AUTH_SIGN_UP_ENV = "PAPERCLIP_AUTH_SIGN_UP";
export const LEGACY_AUTH_DISABLE_SIGN_UP_ENV = "PAPERCLIP_AUTH_DISABLE_SIGN_UP";

function isAuthSignUpMode(value: string): value is AuthSignUpMode {
  return (AUTH_SIGN_UP_MODES as readonly string[]).includes(value);
}

/**
 * Resolves the sign-up mode from the new setting and the legacy boolean flag.
 *
 * Precedence, highest first:
 * 1. `PAPERCLIP_AUTH_SIGN_UP` (env)
 * 2. `auth.signUp` (config file)
 * 3. `PAPERCLIP_AUTH_DISABLE_SIGN_UP` (legacy env): `"true"` means `disabled`,
 *    any other value means `open`, exactly as before
 * 4. `auth.disableSignUp` (legacy config file): `true` means `disabled`
 * 5. `open`
 *
 * The new setting always wins over the legacy flag, from any source. An
 * unknown `PAPERCLIP_AUTH_SIGN_UP` value is a startup error: a typo must not
 * silently fall back to open registration.
 */
export function resolveAuthSignUpMode(input: {
  envSignUp: string | undefined;
  envDisableSignUp: string | undefined;
  fileSignUp: AuthSignUpMode | undefined;
  fileDisableSignUp: boolean | undefined;
}): AuthSignUpMode {
  const envSignUp = input.envSignUp?.trim().toLowerCase();
  if (envSignUp) {
    if (!isAuthSignUpMode(envSignUp)) {
      throw new Error(
        `${AUTH_SIGN_UP_ENV} must be one of ${AUTH_SIGN_UP_MODES.join(", ")} (got "${input.envSignUp}")`,
      );
    }
    return envSignUp;
  }
  if (input.fileSignUp) return input.fileSignUp;
  if (input.envDisableSignUp !== undefined) {
    return input.envDisableSignUp === "true" ? "disabled" : "open";
  }
  return input.fileDisableSignUp ? "disabled" : "open";
}
