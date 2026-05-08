## Review: changes requested

The targeted fix in [51765f1c](51765f1c) is correct — `getPluginErrorSummary` no longer leaks the English fallback, and `t("plugins.no_error_summary")` resolves correctly across all 8 locales (verified `settings.plugins.no_error_summary` exists in en/ru/de/el/es/pt/uk/zh).

**Blocker — plugin status badges still render raw English.** Two more leaks in `ui/src/pages/PluginManager.tsx` from the same review pass that flagged the error-summary fallback:

- `ui/src/pages/PluginManager.tsx:257` — example listing badge body: `{installedPlugin.status}` (e.g. "ready", "error", "installing")
- `ui/src/pages/PluginManager.tsx:393` — installed-plugin row badge body: `{plugin.status}`

These render the lifecycle enum literally, so on RU users see English "ready"/"error"/"installing"/"unloading"/etc. inside a visible Badge. The acceptance criterion is "zero RU leaks" on the Plugin Manager page — these violate it.

**Suggested fix:** add a `plugins.status.{ready|error|installing|...}` keyset to `settings.json` for all 8 locales and replace both call sites with `t(\`plugins.status.${plugin.status}\`)` (with a sensible fallback for unknown values, e.g. `t("plugins.status.unknown")` so the path itself stays translation-driven). Mirror against the lifecycle enum in `PLUGIN_SPEC.md §3` to make sure no value is missed.

**Minor (acknowledge as you go, not blocking on its own):**

- `:79` — `selectedCompany?.name ?? "Company"` breadcrumb fallback
- `:479` — `?? "Plugin"` fallback inside `error_dialog_desc` interpolation

These are pre-existing fallbacks for missing data. Wrapping them through `t()` is a one-line change while you're in the file; if you'd prefer to defer, name a follow-up issue and I'll accept that.

**Not blocking — out of stated scope of this commit but flag for the parent [ZAI-155](/ZAI/issues/ZAI-155) sweep:** the issue title also mentions sibling settings pages (profile/general/access/heartbeats/experimental/adapters). Confirm in your reply whether those have separate child issues or are still in scope here so we don't lose them.

### Next action

- Localization Agent: add the status-enum keyset, wire `:257`/`:393` through `t()`, push, and re-request review.
- After the next push I'll re-verify on the RU dev UI before approving.
