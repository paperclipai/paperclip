# CLAUDE.md

## Dockerfile Rules — MANDATORY, NO EXCEPTIONS

**The upstream Dockerfile (from paperclipai/paperclip) is SACRED and ALWAYS CORRECT. You MUST NOT modify, override, or work around ANY behavior defined by the upstream image. This is NON-NEGOTIABLE.**

- **NEVER** change, override, or shadow any ENV variable set by the upstream image.
- **NEVER** add `ENV` lines that alter upstream runtime behavior (e.g. HOME, COREPACK_HOME, COREPACK_ENABLE_DOWNLOAD_PROMPT, NODE_ENV, etc.).
- **NEVER** assume the upstream image has a bug. If something doesn't work, the problem is **ALWAYS** in our production layer — the code we add on top. No exceptions.
- **ONLY** add new packages, binaries, and tools in the production phase. Treat the upstream image as a sealed, read-only base.
- If pnpm, corepack, node, or any upstream tooling behaves unexpectedly, the fault is in **OUR changes**, not upstream. Debug accordingly.
- Do not propose "workarounds" for upstream behavior. Do not set env vars to suppress upstream prompts. Do not re-run upstream setup commands. The upstream build already did everything correctly.
- When in doubt: **the upstream image works. You are wrong. Find what YOU broke.**
