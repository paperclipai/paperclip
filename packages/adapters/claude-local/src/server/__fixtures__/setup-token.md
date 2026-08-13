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