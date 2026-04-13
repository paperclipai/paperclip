---
name: code-search
description: "Search and explore the codebase using ripgrep and tree-sitter. Trigger on: "search for", "find where X is defined", "trace call sites of X", "how is X used", "where is X implemented", "explore the codebase", "find usages of X"."
license: MIT
compatibility: opencode
metadata:
  audience: developers
  workflow: code-search
roles: [cto, developer]
---

# Code Search: ripgrep + tree-sitter

## MANDATORY: explore agent MUST use this skill

## Tool Priority

```
1. tree-sitter query — structural: definitions, classes, methods
2. rg (ripgrep)      — textual: strings, call sites, patterns
3. glob + Read       — file listing and reading
```

Never use `find`, `cat | grep`, or `ls -R` for search.

## Missing tools

If `tree-sitter` or `rg` is unavailable, **stop and ask the user to install it** before proceeding:

- `tree-sitter` missing → "tree-sitter CLI is not installed. Install it? (`brew install tree-sitter-cli`)"
- `rg` missing → "ripgrep (`rg`) is not installed. Install it? (`brew install ripgrep` / `apt install ripgrep`)"

Only fall back to inferior tools (`grep`, `find`) if the user explicitly declines to install.

## tree-sitter configuration check

**MANDATORY CHECK:** On first use of this skill, verify tree-sitter is configured:

```bash
tree-sitter dump-languages 2>&1 | head -5
```

If you see "Warning: You have not configured any parser directories!", **STOP and offer to configure:**

> "tree-sitter is installed but not configured. This limits search precision for finding definitions.
>
> **Configure it now?**
> 1. Run `tree-sitter init-config` — creates `~/.config/tree-sitter/config.json` with default `parser-directories` (e.g., `~/github`, `~/src`)
> 2. Clone grammars into one of those directories:
>    ```bash
>    git clone https://github.com/tree-sitter/tree-sitter-python ~/github/tree-sitter-python
>    git clone https://github.com/tree-sitter/tree-sitter-typescript ~/github/tree-sitter-typescript
>    ```
> 3. Verify: `tree-sitter dump-languages` should list the installed languages
>
> Or proceed with ripgrep-only search (slower for finding definitions)?"

**Only proceed with ripgrep fallback if user explicitly declines to configure.**

**When tree-sitter is unconfigured (after user declines), adjust tool priority:**

```
1. rg (ripgrep)      — all searches (textual + structural)
2. glob + Read       — file listing and reading
```

## Decision Rule

**If tree-sitter is configured:**
- **Definition/declaration** → `tree-sitter query` with S-expression pattern
- **Call site / string / config / comment** → `rg`
- **File listing** → `glob`

**If tree-sitter is NOT configured:**
- **All searches** → `rg` with appropriate flags (`-t <lang>`, `-n`, `--glob`)
- **File listing** → `glob`

## tree-sitter query usage

Queries are written inline and run with:

```bash
tree-sitter query <(cat <<'EOF'
(your_query_here)
EOF
) path/to/file.py
```

### Common patterns

```scheme
; Function definition (Python)
(function_definition name: (identifier) @name (#eq? @name "my_func"))

; Function/method (TypeScript) — named declarations
(function_declaration name: (identifier) @name (#eq? @name "myFn"))
(method_definition name: (property_identifier) @name (#eq? @name "myMethod"))

; Arrow function / const assignment (TypeScript) — most common in modern TS/JS
(lexical_declaration
  (variable_declarator
    name: (identifier) @name (#eq? @name "myFn")))

; Class
(class_declaration name: (type_identifier) @name (#eq? @name "MyClass"))
```

> **Note:** Modern TypeScript uses `const fn = () => {}` (lexical_declaration), not `function fn()` (function_declaration). If a query returns no results on a `.ts` file, try the `lexical_declaration` pattern.

Check available grammars: `tree-sitter dump-languages`.

## rg essentials

```bash
rg -n "symbol(" src/           # call sites, with line numbers
rg -n "pattern" -t py          # filter by language type
rg -l "pattern" src/           # files only (no line content)
rg -n "pattern" -A 3 -B 1      # with context
rg -n "pattern" --glob "*.ts"  # glob filter
```

rg respects `.gitignore` automatically — no need to exclude `node_modules`.

## Standard workflow: "where is X and how is it used"

1. `tree-sitter query` → find definition, get file + line
2. `Read` with offset → understand signature
3. `rg -n "X(" src/ -A 2` → find call sites
4. `Read` callers as needed

## Anti-patterns

| Wrong | Right |
|-------|-------|
| `find . -name "*.ts" \| xargs grep` | `rg -n "..." -t ts` |
| `rg` to find class definitions | `tree-sitter query` |
| Read full 500-line file for one function | `tree-sitter query` → `Read` with offset |
| `grep -r` without path/type scope | Always scope: `-t <lang>` or `src/` |
| `function_declaration` query returns nothing on `.ts` | Try `lexical_declaration` for arrow functions |
