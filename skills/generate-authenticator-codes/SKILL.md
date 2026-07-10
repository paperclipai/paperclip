---
name: generate-authenticator-codes
description: Generate time-based one-time passwords (TOTP/2FA/authenticator codes) safely from an otpauth QR-code screenshot, a Paperclip issue image attachment, an otpauth URI, or a Base32 setup secret. Use when an agent must complete an authenticator-app challenge in a browser or CLI, when the user says to use the 2FA/authenticator generator, or when an attached screenshot contains an authenticator enrollment QR code.
---

# Generate authenticator codes

Use the bundled helper instead of implementing TOTP ad hoc or trying to read a QR payload visually. The helper decodes QR images locally, generates the current code, and never prints the reusable seed.

## Procedure

1. Confirm that the user asked you to use the authenticator code for the account or service in scope. Treat the QR code, `otpauth://` URI, and Base32 seed as password-equivalent secrets.
2. Resolve `scripts/totp.mjs` relative to this `SKILL.md` and keep its absolute path in `AUTHENTICATOR_SCRIPT`.
3. Prefer the narrowest available input:
   - Current Paperclip issue with an attached QR screenshot:
     `node "$AUTHENTICATOR_SCRIPT" --issue "$PAPERCLIP_TASK_ID"`
   - Specific Paperclip attachment:
     `node "$AUTHENTICATOR_SCRIPT" --attachment <attachment-id>`
   - Local screenshot:
     `node "$AUTHENTICATOR_SCRIPT" --image /absolute/path/to/screenshot.png`
   - URI or manual secret: use `--uri`, or `--secret` with optional `--algorithm`, `--digits`, and `--period`.
4. Use the returned code immediately. If automating a page, type it directly into the authenticator field and submit it; do not paste it into an issue comment.
5. Delete any temporary local copy you created. The helper automatically removes files it downloads from Paperclip.

`--issue` reads the authenticated heartbeat-context endpoint, checks attached images newest-first, and uses the newest decodable `otpauth://totp/...` QR code. It requires the normal `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` heartbeat variables.

## Safety rules

- Never print, comment, log, or commit the QR payload, setup URI, Base32 seed, backup codes, session cookies, or API key.
- Never guess or OCR an unreadable QR code. Ask for a clearer PNG/JPEG screenshot or the manual setup key.
- Never save a TOTP seed for future use unless the user explicitly asks for persistent enrollment and an approved encrypted secret store is available.
- Never disable, reset, or replace an account's existing 2FA enrollment unless explicitly requested.
- Do not delete the source Paperclip attachment automatically. It belongs to the issue record; ask before deleting it.
- If several accounts or QR codes could match, identify the intended service/account before submitting a code.

## Helper output

The default output is JSON containing only the ephemeral code, its remaining validity, digits, period, and non-secret source label. Use `--code-only` only when a downstream command requires the bare code. The helper waits briefly for a fresh window when the current code is about to expire; override this with `--min-validity 0` only when needed.
