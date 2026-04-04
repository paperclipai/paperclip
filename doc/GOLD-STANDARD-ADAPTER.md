# Paperclip Gold Standard Adapter

This document defines the gold standard for creating new LLM adapters in Paperclip, based on existing adapters (`claude-local`, `codex-local`, `cursor-local`, `gemini-local`). The goal is to ensure consistency, interoperability, and easy maintenance when adding support for new LLMs.

---

## Directory Structure

Every adapter must follow the following minimum structure:

```
adapter-package/
  package.json
  tsconfig.json
  src/
    index.ts
    cli/
      index.ts
      format-event.ts
      quota-probe.ts (optional)
    server/
      index.ts
      execute.ts
      parse.ts
      quota.ts (or quota-spawn-error.test.ts)
      skills.ts
      test.ts
    ui/
      index.ts
      build-config.ts
      parse-stdout.ts
    shared/ (optional)
      stream.ts
      trust.ts
```

- **src/index.ts**: Entry point of the adapter, registers and exports the main functions.
- **src/cli/**: CLI scripts for integration, event formatting, and quota probing.
- **src/server/**: Backend implementation of the adapter (execution, parsing, quota, skills, tests).
- **src/ui/**: Components and utilities for configuration and adapter interface.
- **src/shared/**: Shared utilities between server/cli/ui (optional).

---

## Interfaces and Contracts

### 1. Adapter Registration
- The adapter must register itself using the Paperclip registration system in `src/index.ts`.
- Export main functions (e.g., `registerAdapter`, `getAdapterConfig`).

### 2. Command Execution
- Implement `src/server/execute.ts` to handle the execution of LLM prompts and commands.
- Use streams for long responses.
- Follow the input/output contract defined in `packages/shared`.

### 3. Parsing
- Implement `src/server/parse.ts` to transform raw LLM output into Paperclip events.
- Also implement `src/ui/parse-stdout.ts` for frontend parsing if necessary.

### 4. Quota and Limits
- Implement `src/server/quota.ts` for token usage and limit control.
- Optional: `quota-probe.ts` for CLI-based probing.

### 5. Skills
- Implement `src/server/skills.ts` to expose LLM abilities (e.g., codegen, chat, tool-use).

### 6. Testing
- Implement tests in `src/server/test.ts` and/or `.test.ts` files.

### 7. UI
- Implement `src/ui/build-config.ts` to build the adapter configuration form.
- Implement `src/ui/index.ts` to register custom UI components.

---

## Coding Conventions
- Use TypeScript.
- Follow types and contracts defined in `packages/shared`.
- Prefer pure functions and decoupled components.
- Document public functions.
- Use clear and standardized names for files and functions.

---

## Checklist for New Adapter

- [ ] Folder structure matches standard
- [ ] Correct registration in `src/index.ts`
- [ ] Execution implementation (`execute.ts`)
- [ ] Output parsing (`parse.ts`, `parse-stdout.ts`)
- [ ] Quota control (`quota.ts`)
- [ ] Skills exposure (`skills.ts`)
- [ ] Basic tests (`test.ts`)
- [ ] Configuration UI (`build-config.ts`, `ui/index.ts`)
- [ ] Types and contracts aligned with `packages/shared`

---

## References
- See existing adapters in `packages/adapters/` for reference.
- Consult `doc/SPEC-implementation.md` for updated contracts and requirements.
- For questions, also consult the adapter creation guide in `.agents/skills/create-agent-adapter/SKILL.md`.

---

**This document must be reviewed and updated whenever there are structural changes to adapters or the Paperclip core.**
