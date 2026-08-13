# Claude `setup-token` characterization fixture

- Characterized: 2026-08-11
- Claude Code: `2.1.205`
- Intended repository path: `packages/adapters/claude-local/src/server/__fixtures__/setup-token.md`
- Safety: no real authorization URL, browser code, or token is recorded here.

## Pipe stdio

Invocation: all three child streams were pipes; stdin remained open for 8 seconds, then received a syntactically shaped synthetic code followed by LF (`\
`).

- Exact emitted prompt text: none.
- stdout: 0 bytes.
- stderr: 0 bytes.
- Input echo: none (the pipe path emitted nothing).
- Result: still running after 23 seconds; controlled termination was required.
- Wrapper exit: `124` from `timeout`; direct child termination in the equivalent harness: `SIGKILL` (`-9`).
- Conclusion: `setup-token` requires a PTY to expose and drive its interactive login UI. Supplying pipe stdin alone is insufficient.

## PTY stdio

Normalized rendered text (spinner frames and terminal control sequences omitted):

```text
Welcome to Claude Code v2.1.205
Opening browser to sign in…
Browser didn’t open? Use the url below to sign in (c to copy)
<REDACTED_AUTHORIZATION_URL>
Paste code here if prompted >
```

Authorization URL shape:

- Origin: `https://claude.com`
- Path: `/cai/oauth/authorize`
- Query keys (values redacted): `client_id`, `code`, `code_challenge`, `code_challenge_method`, `redirect_uri`, `response_type`, `scope`, `state`
- Fragment: absent
- The terminal emits the same URL through an OSC 8 hyperlink plus wrapped display text; consumers must tolerate ANSI/OSC sequences and line wrapping.

Code-entry behavior:

- Observed code delimiter: `#`.
- Submission terminator: carriage return/Enter in the PTY; the synthetic pipe attempt used LF.
- Echo: input is masked as `*` characters; the synthetic code itself is not rendered by Claude.
- Prompt stream: the PTY’s terminal output stream (stdout/stderr are not independently observable once attached to one PTY).

Invalid-code result:

```text
OAuth error: Request failed with status code 400
Press Enter to retry.
```

- The invalid code does not make the command exit; it remains at the retry UI.
- Controlled PTY termination: wrapper exit `124`; direct child termination in the harness: `SIGKILL` (`-9`).

## Deferred success-token assumption

No real login or token was captured in this phase. Implementation should provisionally expect an opaque setup token shaped like `sk-ant-oat01-<opaque>` on the interactive terminal output stream after successful authorization. Both the exact prefix/length/delimiters and whether a non-PTY capture classifies the success line as stdout or stderr remain explicit assumptions. Confirm them once in the final live end-to-end implementation test before locking parser assertions.

## Smallest proof

`claude --version`; one pipe harness with a synthetic invalid code; and one PTY harness with bracketed-paste input showed the stream split, redacted URL structure, masked echo, HTTP 400 retry behavior, and controlled terminal exits. A literal scan of this document confirms it contains no authorization query values, browser code, or live token.
## Re-characterization on Claude Code 2.1.226 (2026-08-13)

- Re-characterized: 2026-08-13
- Claude Code: `2.1.226`
- Environment: real pseudo-terminal, headless, no browser. Prompt phase only; no
  login was completed and no token was minted.
- Safety: no real authorization URL, browser code, or token is recorded here.

A live run of `claude setup-token` on a real pseudo-terminal confirmed the prompt
contract is unchanged in substance from `2.1.205`:

- URL preamble line: `Browser didn't open? Use the url below to sign in (c to copy)`.
- Authorization URL origin `https://claude.com`, path `/cai/oauth/authorize`, the
  same eight query keys (`client_id`, `code`, `code_challenge`,
  `code_challenge_method`, `redirect_uri`, `response_type`, `scope`, `state`), no
  fragment. The `redirect_uri` value host is `https://platform.claude.com`.
- Browser-code prompt line: `Paste code here if prompted >`.

The live run recorded two terminal-rendering behaviors that the earlier
normalized capture hid. The parser now handles both:

1. Word spacing. The login UI lays out each word at an absolute column with a
   Cursor Horizontal Absolute (`ESC[<n>G`) sequence, so it emits no literal space
   between two words. A parser that removes the control sequence glues the words
   together. The parser now renders each horizontal-move sequence as one space.
2. Repeated URL. The UI emits one OSC 8 hyperlink per wrapped display row, so it
   repeats the full authorization URL on a few consecutive lines before the
   prompt. The parser now skips a repeated URL line and binds the prompt on the
   first non-blank line after the URL block; any other unrelated line still fails
   the bind.

The success anchors and the token shape were not re-run live, because a real
login needs a subscription and an out-of-band browser. They stay as recorded in
[`setup-token-success.md`](./setup-token-success.md): the before-anchor line
`Your OAuth token (valid for 1 year):`, the after-anchor line `Store this token
securely. You won't be able to see it again.`, and the token prefix
`sk-ant-oat01-`. The success screen renders its anchor words with the same
Cursor Horizontal Absolute spacing, so the same rendering fix applies to the
token parser.

An executable characterization test drives this live run. See
[`../setup-token-characterization.test.ts`](../setup-token-characterization.test.ts);
it is opt-in through `RUN_CLAUDE_SETUP_TOKEN_CHARACTERIZATION=1`.
