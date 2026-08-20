# JAC-4745 Recovery Script Fix — Evidence

## Issue
JAC-4745 [JAC-4503-BLOCKER] Human operator required to generate new Ollama Cloud API key

## Problem Found
Commit e1c67955e claimed to fix `scripts/ollama-cloud-key-recovery.sh` by replacing `***` with `$NEW_KEY` on line 91. However:

1. **Git diff showed `***` on BOTH sides** — appearing to be a no-op change
2. **Byte-level inspection (xxd) revealed the actual state**: Both the parent (e1c67955e^) and e1c67955e commits already had `$NEW_KEY` (hex: `24 4e 45 57 5f 4b 45 59`). The `***` in diff/read output is a platform output-redaction artifact masking `$NEW_KEY`.
3. **The actual bug**: Commit e1c67955e removed the trailing backslash (`\`) line continuation from line 91.

### Parent (e1c67955e^) line 91 — CORRECT
```
  -H "Authorization: Bearer $NEW_KEY" \
```
Hex: `... 22 20 5c 0a` (ends with `" \` + newline — proper bash line continuation)

### e1c67955e line 91 — BROKEN  
```
  -H "Authorization: Bearer $NEW_KEY"
```
Hex: `... 22 0a` (ends with `"` + newline — MISSING backslash, curl syntax broken)

### Impact of the bug
Without the line continuation, bash treats the subsequent `-H` line as a separate command, causing:
```
curl: (2) no URL specified
/bin/bash: -H: command not found
EXIT CODE: 127
```

## Fix Applied
Commit 526098818: Restored the `\` line continuation on line 91.

Line 91 now reads (raw bytes):
```
  -H "Authorization: Bearer $NEW_KEY" \
```
Hex: `... 22 20 5c 0a` (ends with `" \` + newline — proper line continuation)

## Verification
- `bash -n scripts/ollama-cloud-key-recovery.sh` — PASSED
- curl block with dummy key — returns HTTP 405 from example.com (syntax valid, was previously exit 127)
- Working tree diff: 1 insertion, 1 deletion (adding ` \`)
- git log confirms both commits present

## Disposition
The recovery script is now fully functional. JAC-4745 remains **blocked** on the human operator (Jack) generating the Ollama Cloud API key at https://ollama.com/settings/api-keys. Once the key is provided, the script can be run:
```bash
bash scripts/ollama-cloud-key-recovery.sh "$OLLAMA_NEW_KEY"
```
The script will propagate to all 8 fleet profile locations and verify with a live POST to https://ollama.com/v1/chat/completions.