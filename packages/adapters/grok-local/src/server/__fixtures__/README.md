# Device-login sample fixture

This fixture holds redacted, real Grok device-login output. A capture step ran
`grok login --device-auth` inside a Daytona sandbox and recorded the output. The
capture step redacted every secret before it kept the text. The parser test
reads this fixture. The test never reads a live secret.

## Source

- Capture date (UTC): `2026-08-28`.
- CLI version: `grok 1.0.5 (5115b46bc9)`.
- Host: Daytona sandbox, Ubuntu 22.04, `x86_64`.
- Transport: a pipe with no pseudo-terminal. The Grok prompt reaches a plain
  pipe, so the fixture holds line-feed-only line endings, with no carriage
  return.

## File

| File | Condition | Expected parse result |
|---|---|---|
| `device-login-prompt.txt` | Normal prompt, no pseudo-terminal | a URL and a code |

## Redaction

The capture step transformed every real one-time code to the placeholder
`XXXX-XXXX`. The placeholder keeps the observed shape: four characters, a
hyphen, then four characters. The parser matches this grounded structure and
does not invent an alphabet, so the committed fixture parses to a code with no
real secret in the repository.

The capture step checked the final text for common credential field names and
for an unredacted device-code pattern. It found no match.
