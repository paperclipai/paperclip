# Claude `setup-token` success characterization fixture

- Characterized: 2026-08-12
- Claude Code: `2.1.205`
- Environment: Daytona sandbox (Ubuntu, kernel 6.8), headless, no browser.
- Intended repository path: `packages/adapters/claude-local/src/server/__fixtures__/setup-token-success.md`
- Safety: no real authorization URL, browser code, or token is recorded here. Every
  secret is replaced by a `<REDACTED_*>` placeholder. The raw PTY capture that
  produced this document was written only to a sandbox-local file and shredded
  after redaction.

This fixture resolves the "Deferred success-token assumption" in
[`setup-token.md`](./setup-token.md): it records a real, end-to-end successful
login through a PTY, with the human completing the browser authorization out of
band. It is the success counterpart to that document, which characterized the
prompt, the URL, and the invalid-code retry path only.

## Full successful PTY session

Normalized rendered text (spinner frames, cursor-movement sequences, and other
terminal control sequences omitted; word spacing restored from cursor-forward
sequences):

```text
Welcome to Claude Code v2.1.205

Opening browser to sign in…
<spinner frames>
Browser didn't open? Use the url below to sign in (c to copy)

<REDACTED_AUTHORIZATION_URL>

Paste code here if prompted > <MASKED_CODE>

✓ Long-lived authentication token created successfully!

Your OAuth token (valid for 1 year):

<REDACTED_SETUP_TOKEN>

Store this token securely. You won't be able to see it again.

Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>
```

The command reached the success screen and then closed the PTY and exited on its
own — no host-side kill was required (unlike the invalid-code path in
`setup-token.md`, which stayed at a retry UI and had to be terminated).

## Authorization URL shape

Unchanged from `setup-token.md`; confirmed again on the success run:

- Origin: `https://claude.com`
- Path: `/cai/oauth/authorize`
- Query keys (values redacted): `client_id`, `code`, `code_challenge`,
  `code_challenge_method`, `redirect_uri`, `response_type`, `scope`, `state`
- Observed `redirect_uri` value host: `https://platform.claude.com/oauth/code/callback`.
- Observed `scope` value: `user:inference`. Observed `response_type`: `code`.
- Fragment: absent.
- The terminal emits the URL through an OSC 8 hyperlink plus wrapped display
  text; consumers must tolerate ANSI/OSC sequences and line wrapping.

## Code submission mechanics (PTY)

This is the operational detail that a driver must get right, and it is not
obvious from the prompt characterization alone.

- The browser code is the value the sign-in page shows after authorization. Its
  observed shape is `<authorization_code>#<state>` — the `#` delimiter and the
  trailing `state` match the `state` query value from the authorization URL.
- **A single PTY write of `code + "\r"` did not submit.** The Claude Code input
  is an Ink text field with paste handling: when the code and the carriage
  return arrive glued together in one write burst, the trailing `\r` is folded
  into the pasted text instead of being read as a Return (submit) key. The stream
  stalls at the prompt with the code masked but unsubmitted, and no error is
  emitted.
- **A separate, standalone `\r` written after the paste submits on the first
  Return.** The reliable sequence is: write the code bytes, let the paste buffer
  settle briefly, then write `\r` as its own write.
- Echo: input is masked as `*` characters; the code itself is never rendered by
  Claude. (The non-secret `state` suffix may remain visible at the tail of the
  masked echo, because it is public — it is the same `state` carried in the URL.)

> Implementation note for `setup-token-runner.ts`: the runner now writes the
> code and `CODE_SUBMISSION_TERMINATOR` as two separate writes — `driver.write(code)`,
> a short settle delay (`CODE_SUBMIT_SETTLE_MS`), then `driver.write(CODE_SUBMISSION_TERMINATOR)`.
> A single glued `code + "\r"` burst did not submit against this Claude Code
> build: the trailing `\r` folded into the pasted text. The separate Return,
> after the paste buffer settles, submits on the first Return. Confirm the exact
> settle delay in the live end-to-end test.

## Success token shape (resolves the deferred assumption)

The provisional assumption in `setup-token.md` — an opaque token shaped like
`sk-ant-oat01-<opaque>` on the interactive terminal output stream after
successful authorization — is **confirmed**:

- Prefix: `sk-ant-oat01-` (literal; hyphen-delimited segments `sk`, `ant`,
  `oat01`, then the opaque secret).
- The opaque tail is a long secret over the character class `[A-Za-z0-9_-]`; it
  may contain `-`, so a parser must not assume the token stops at the first
  hyphen or non-alphanumeric after the prefix.
- **Line wrapping:** like the authorization URL, the token is wrapped across
  physical terminal lines at the PTY width (an ~80-column PTY split it into two
  lines). A parser must de-wrap — join across the wrap boundary — to recover the
  full token. Capturing with a wide PTY (e.g. many hundreds of columns) avoids
  the split at the source.
- The token is introduced by the exact line `Your OAuth token (valid for 1
  year):` and followed by `Store this token securely. You won't be able to see
  it again.` — these bracket the token region and are stable anchors for a
  parser.

## Token delivery and persistence

- The success token is delivered **only on the interactive terminal (PTY)
  stream.** As with the earlier characterization, stdout/stderr are not
  independently observable once attached to one PTY.
- `claude setup-token` does **not** persist the token. After a successful run:
  - `~/.claude.json` gained no `oauthAccount` and no token-bearing field (it held
    only machine/user metadata: `userID`, `machineID`, migration flags, etc.).
  - No `~/.claude/.credentials.json` was written.
- Therefore the runner must capture the credential from the terminal stream at
  the moment it is printed; there is no on-disk artifact to read afterward, and
  the UI explicitly warns the token cannot be shown again.

## Deferred items now resolved / still open

Resolved by this capture:

- Token prefix, delimiter structure, character class, and line-wrapping behavior.
- Success-screen wording and the anchor lines around the token.
- Delivery channel (terminal-only) and the absence of any persisted credential.
- The self-initiated, no-kill exit on success.
- The PTY code-submission gotcha (glued `code + "\r"` vs. a separate Return).

Still worth confirming in the live end-to-end implementation test before locking
parser/runner assertions:

- The exact process exit code on success. The child reached EOF and exited on its
  own immediately after printing the token (a self-initiated exit consistent with
  success); the capture harness issued its normal post-run stop during cleanup,
  so an exact numeric code was not force-observed here. `setup-token-runner.ts`
  treats `exitCode === 0` as success — assert this against a live run.
- The exact opaque-tail length. It is fixed-format per account but was not pinned
  here to avoid recording token-derived specifics.

## Smallest proof

One PTY harness drove `claude setup-token` to completion: it captured the
redacted authorization URL, a human completed the browser authorization out of
band, the harness typed the returned code and submitted it with a separate
Return, and Claude Code printed a `sk-ant-oat01-…` token and exited on its own. A
literal scan of this document confirms it contains no authorization query values,
browser code, or live token.
