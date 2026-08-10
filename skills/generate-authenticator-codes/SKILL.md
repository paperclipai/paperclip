---
name: generate-authenticator-codes
description: Safely enroll, discover, and use company-scoped TOTP/2FA codes from Paperclip's encrypted authenticator vault, QR screenshots or attachments, otpauth URIs, or Base32 secrets. Use for authenticator setup, assigning a generator, or completing a six-digit challenge; never expose the seed.
---

# Generate authenticator codes

Use the bundled helper instead of implementing TOTP ad hoc or trying to read a QR payload visually. Prefer Paperclip's company-scoped encrypted authenticator vault for repeat access. The helper can enroll a screenshot without printing its seed and lets bound agents discover and retrieve only current codes.

## Procedure

1. Treat the QR code, `otpauth://` URI, and Base32 seed as password-equivalent secrets.
2. Resolve `scripts/totp.mjs` relative to this `SKILL.md` and keep its absolute path in `AUTHENTICATOR_SCRIPT`.
3. For an already-enrolled account, discover assigned authenticators and retrieve by name:
   - `node "$AUTHENTICATOR_SCRIPT" --list-native`
   - `node "$AUTHENTICATOR_SCRIPT" --current-native "Google Workspace"`
4. When the user explicitly asks to save, enroll, or assign a new generator, save it to the encrypted company vault. An issue screenshot assigned to you defaults to binding the authenticator to you:
   - `node "$AUTHENTICATOR_SCRIPT" --issue "$PAPERCLIP_TASK_ID" --save-name "Google Workspace — account@example.com"`
   - Add another agent with one or more `--assign-agent <agent-uuid>` options.
5. For one-off generation that must not be saved, prefer the narrowest available input:
   - Current Paperclip issue with an attached QR screenshot:
     `node "$AUTHENTICATOR_SCRIPT" --issue "$PAPERCLIP_TASK_ID"`
   - Specific Paperclip attachment:
     `node "$AUTHENTICATOR_SCRIPT" --attachment <attachment-id>`
   - Local screenshot:
     `node "$AUTHENTICATOR_SCRIPT" --image /absolute/path/to/screenshot.png`
   - URI or manual secret: use `--uri`, or `--secret` with optional `--algorithm`, `--digits`, and `--period`.
6. Use the returned code immediately. If automating a page, type it directly into the authenticator field and submit it; do not paste it into an issue comment.
7. Delete any temporary local copy you created. The helper automatically removes files it downloads from Paperclip.

`--issue` reads the authenticated heartbeat-context endpoint, checks attached images newest-first, and uses the newest decodable `otpauth://totp/...` QR code. It requires the normal `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` heartbeat variables.

## Safety rules

- Never print, comment, log, or commit the QR payload, setup URI, Base32 seed, backup codes, session cookies, or API key.
- Never guess or OCR an unreadable QR code. Ask for a clearer PNG/JPEG screenshot or the manual setup key.
- Save a TOTP seed only when the user explicitly asks for persistent enrollment. Paperclip's native company authenticator vault is the approved encrypted store; never substitute an issue comment, workspace file, or ordinary environment variable.
- Never disable, reset, or replace an account's existing 2FA enrollment unless explicitly requested.
- Do not delete the source Paperclip attachment automatically. It belongs to the issue record; ask before deleting it.
- If several accounts or QR codes could match, identify the intended service/account before submitting a code.

## Helper output

The default output is JSON containing only the ephemeral code, its remaining validity, digits, period, and non-secret source label. Use `--code-only` only when a downstream command requires the bare code. The helper waits briefly for a fresh window when the current code is about to expire; override this with `--min-validity 0` only when needed.
