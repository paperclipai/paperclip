# Historical native instruction source fixture

`native-instruction-sources.json.gz` retains the UTF-8 source files used by the
historical instruction comparison. Unit validation can read these sources in a
shallow checkout without network access or Git history. The test reads the
contents as data. It does not execute the retained source code.

The JSON maps each variant to its `sourceSha` and a `files` object. Each key in
`files` is a repository-relative path. Its value is the exact source text from
that commit.

| Variant | Source commit |
| --- | --- |
| `baseline` | `2a8a99e4a5f69aa803b3f10b982f583e75a87042` |
| `opencodeFeedbackResponses` | `a386a599983519eb1d399f8b770bfccdb2a74762` |

The paths and SHA-256 checks remain in `NATIVE_INSTRUCTION_VARIANTS` in
`../native-instruction-consolidation.ts`. The test checks both complete variants
against those hashes and still rejects changed or mixed source files. The
separate ancestry tests still use real disposable Git repositories.

To regenerate the fixture, read each declared path with `git show SHA:path`
from the commits above. Store each result as UTF-8 text in the JSON object.
Serialize with sorted keys, no extra whitespace, and unescaped Unicode.
Compress with gzip and set its modification time to zero. Do not substitute
current source files or update the accepted hashes to match a fixture.

Fixture SHA-256: `99ecbfdfceb5f9328cb937740bbe06e9fe797d19b4d9b07182a1a0976f2e5825`.
