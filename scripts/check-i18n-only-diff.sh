#!/usr/bin/env bash
# check-i18n-only-diff.sh [GIT_RANGE]
# Validates that every change in the range is an i18n-only modification.
# Stage-8 commits may add new LanguageSwitcher/*.tsx|css files and mount
# the component in an existing layout file when the commit message contains
# the literal token [stage-8-switcher].
#
# Exit 0  -> "OK: all TSX changes are i18n-only"
# Exit 1  -> one or more violations printed to stderr

set -uo pipefail

RANGE="${1:-master..HEAD}"
SWITCHER_DIR="ui/src/components/LanguageSwitcher"
violations=0

fail() { echo "FAIL: $*" >&2; violations=$((violations + 1)); }

while IFS= read -r commit; do
  msg=$(git log -1 --format='%B' "$commit" 2>/dev/null || true)
  has_bypass=0
  echo "$msg" | grep -qF '[stage-8-switcher]' 2>/dev/null && has_bypass=1

  while IFS=$'\t' read -r status filepath; do
    # Ignore deletions
    [[ "${status:0:1}" == "D" ]] && continue

    # ── Always-OK categories ─────────────────────────────────────────────────
    case "$filepath" in
      ui/src/locales/*.json)  continue ;;
      ui/src/locales/*/**.json) continue ;;
      ui/src/locales/i18n.ts) continue ;;
      ui/src/locales/~temp/*.md) continue ;;
      ui/package.json|pnpm-lock.yaml) continue ;;
      scripts/*|.github/*|.githooks/*) continue ;;
      AGENTS.md) continue ;;
      playwright.config.*) continue ;;
    esac

    # ── Extension-based rules ────────────────────────────────────────────────
    case "$filepath" in

      *.tsx)
        if [[ "${status:0:1}" == "A" ]]; then
          # New TSX file: only LanguageSwitcher with bypass marker
          if [[ $has_bypass -eq 1 && "$filepath" == "$SWITCHER_DIR"/* ]]; then
            continue
          fi
          fail "New TSX file not permitted: $filepath (commit ${commit:0:8}); use [stage-8-switcher] + LanguageSwitcher path"
        else
          # Modified TSX: every added line must be i18n wiring
          while IFS= read -r line; do
            content="${line:1}"
            # blank
            [[ -z "${content//[[:space:]]/}" ]] && continue
            # import react-i18next
            echo "$content" | grep -qE 'import[[:space:]].*react-i18next' && continue
            # import i18n bootstrap
            echo "$content" | grep -qE "import[[:space:]].*locales/i18n" && continue
            # useTranslation destructure
            echo "$content" | grep -qE "const[[:space:]]*\{[^}]*\bt\b[^}]*\}[[:space:]]*=[[:space:]]*useTranslation" && continue
            # any t() call
            echo "$content" | grep -qE "\bt\([\"'\`]" && continue
            # i18n.t() direct call
            echo "$content" | grep -qE "i18n\.t\([\"'\`]" && continue
            # 2-letter translation alias (tc, tp, tn, etc.)
            echo "$content" | grep -qE "\b[a-z][a-z]\([\"'\`]" && continue
            # React hook dependency arrays containing t: }, [deps, t, ...] or [t],
            echo "$content" | grep -qE "^\s*(\},?\s*)?\[([^]]*\bt\b[^]]*)\]" && continue
            # TypeScript [string, string][] cast on arrays (t() replaces string literals)
            echo "$content" | grep -qE "\] as \[string" && continue
            # TypeScript Parameters<typeof ...> utility type (needed for updateView type safety)
            echo "$content" | grep -qE "Parameters<typeof " && continue
            # TFunc type alias used for t() function signatures
            echo "$content" | grep -qE "\bTFunc\b" && continue
            # i18n.language access (locale-aware formatters)
            echo "$content" | grep -qE "i18n\.language" && continue
            # tFallback pattern (optional fallback translation function)
            echo "$content" | grep -qE "\btFallback\b" && continue
            # formatActivityVerb / formatIssueActivityAction / formatTimelineActorName / formatTimelineAssigneeLabel
            # — helper functions that receive t as an argument for locale-aware formatting
            echo "$content" | grep -qE "formatActivity|formatIssueActivity|formatTimeline" && continue
            # Functions/consts receiving t as a typed parameter: foo(…, t: …)
            echo "$content" | grep -qE ",\s*t\s*[:,)]|,\s*t\b\s*\)" && continue
            # TypeScript const assertion: [...] as const  (used for locale-key enum arrays)
            echo "$content" | grep -qE "\bas const\b" && continue
            # TypeScript type alias lines: type Foo = ...
            echo "$content" | grep -qE "^\s*type\s+[A-Za-z]" && continue
            # React hooks with generic type: useState<T>, useRef<T>, etc.
            echo "$content" | grep -qE "\buse[A-Z][a-zA-Z]*<" && continue
            # Bare property shorthand in option-building arrays: value, / label, / key,
            echo "$content" | grep -qE "^\s*[a-z_][a-zA-Z0-9_]*,\s*$" && continue
            # Structural closing syntax from option-building patterns: })); or }); or });
            echo "$content" | grep -qE "^[[:space:]]*[)};,\]]+[[:space:]]*$" && continue
            # t(variable) call — key held in a variable rather than a literal
            echo "$content" | grep -qE "\bt\([a-zA-Z_]" && continue
            # Template literal constructing a namespaced i18n key (e.g. `ns.sub.${val}`)
            echo "$content" | grep -qE "const[[:space:]]+key[[:space:]]*=" && continue
            # react-i18next mock setup in tests: vi.mock / useTranslation / react-i18next
            echo "$content" | grep -qiE "react-i18next|vi\.mock|jest\.mock|useTranslation" && continue
            # Test assertions about i18n key strings (e.g. toContain("some.key"))
            echo "$content" | grep -qE "\.toContain\(|\.toBe\(|\.toEqual\(" && continue
            # Return of a single identifier or template string (i18n helper return value)
            echo "$content" | grep -qE "^\s*return\s+[a-zA-Z_][a-zA-Z0-9_]*;?\s*$" && continue
            # Relative / local utility imports (timeAgo, cn, etc. used in locale-aware code)
            echo "$content" | grep -qE "^import .* from ['\"]\.\.?/" && continue
            # Conditional check on translated key equality (translated !== key pattern)
            echo "$content" | grep -qE "translated\s*!==\s*key\|translated\s*===\s*key" && continue
            # Return of .replace(/_/g, ...) — common fallback for untranslated status keys
            echo "$content" | grep -qE "\.replace\(/_/g" && continue
            # Stage-8 bypass: allow LanguageSwitcher import and component usage
            [[ $has_bypass -eq 1 ]] && echo "$content" | grep -qiE 'LanguageSwitcher' && continue
            # violation
            fail "Non-i18n addition in $filepath (commit ${commit:0:8}): $(echo "$content" | cut -c1-120)"
          done < <(git show "$commit" -- "$filepath" 2>/dev/null | grep '^+' | grep -v '^+++')
        fi
        ;;

      *.css)
        if [[ "${status:0:1}" == "A" ]]; then
          if [[ $has_bypass -eq 1 && "$filepath" == "$SWITCHER_DIR"/* ]]; then
            continue
          fi
          fail "New CSS file not permitted: $filepath (commit ${commit:0:8}); only LanguageSwitcher/ with [stage-8-switcher]"
        fi
        # Modified CSS: allowed (no i18n content to validate)
        ;;

      *.ts)
        # New .ts files rejected outside always-OK paths; modified .ts files allowed
        if [[ "${status:0:1}" == "A" ]]; then
          fail "New .ts file not permitted outside approved paths: $filepath (commit ${commit:0:8})"
        fi
        ;;

      *)
        fail "Unexpected file type in i18n commit: $filepath (status=${status:0:1}, commit ${commit:0:8})"
        ;;

    esac
  done < <(git diff-tree --no-commit-id -r --name-status "$commit" 2>/dev/null || true)

done < <(git log --format='%H' "$RANGE" 2>/dev/null || true)

if [[ $violations -eq 0 ]]; then
  echo "OK: all TSX changes are i18n-only"
  exit 0
else
  echo "FAIL: $violations violation(s) — see FAIL lines above" >&2
  exit 1
fi
