# Device-login sample fixtures

These fixtures hold redacted, real Codex device-login output. A capture step ran
`codex login --device-auth` inside a Daytona sandbox and recorded the output. The
capture step redacted every secret before it kept or posted the text. The parser
tests read these fixtures. The tests never read a live secret.

## Source

- Capture date (UTC): `2026-08-08`.
- Daytona image: `cr.app.daytona.io/sbox/daytona-6a8d60e245981dd72d0e647e6afae46e0fd7b8bdfdb29b08120747509a39dc33:daytona`.
- Sandbox id: `3bd22e18-2103-4227-b918-6c375fd30b49` (region `us`).
- Codex home: a new throwaway directory for each independent run.

## Files

| File | Row | Condition | Expected parse result |
|---|---|---|---|
| `device-login-sample.txt` | A — normal prompt | `timeout 60 codex login --device-auth` | a URL and a code |
| `device-login-edge.txt` | D — error / retry | offline run with an unreachable local proxy | `null` |

Two more rows from the capture are not committed as fixtures. Row B (timeout
tail) printed no extra Codex line; the external `timeout` process ended the
command with exit status `124`. Row C (`codex login --help`) and Row E
(`codex --version`) are not device-login prompts.

## Redaction

The capture step transformed the real one-time code to question marks and kept
the shape. So `device-login-sample.txt` holds `????-?????` in the code position.
The real code alphabet is a Codex detail and the capture did not keep it. The
parser matches the grounded structure of the code — four characters, a hyphen,
then five characters — and does not invent an alphabet. The token class is bound
to alphanumerics and the redaction sentinel `?`, so the committed sample parses
to a code without a real secret in the repository.

The capture step checked the final text for common credential field names and
for an unredacted device-code pattern. It found no match.
