import * as p from "@clack/prompts";
import pc from "picocolors";

export interface SearchableSelectOption<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

export interface SearchableSelectOptions<T extends string = string> {
  message: string;
  options: SearchableSelectOption<T>[];
  pageSize?: number;
  placeholder?: string;
}

function rankMatch<T extends string>(query: string, option: SearchableSelectOption<T>): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;

  const label = option.label.toLowerCase();
  const hint = option.hint?.toLowerCase() ?? "";
  const value = String(option.value).toLowerCase();

  // Exact match in label
  if (label === q) return 100;
  // Starts with in label
  if (label.startsWith(q)) return 90;
  // Contains in label
  if (label.includes(q)) return 70;
  // Starts with in value
  if (value.startsWith(q)) return 60;
  // Contains in value
  if (value.includes(q)) return 50;
  // Contains in hint
  if (hint.includes(q)) return 30;

  return -1;
}

/**
 * Interactive searchable select using @clack/prompts.
 *
 * Flow:
 * 1. User types a filter query
 * 2. Top matching options are shown in a select
 * 3. User picks one
 *
 * Returns the selected value, or null if cancelled.
 */
export async function searchableSelect<T extends string = string>(
  opts: SearchableSelectOptions<T>,
): Promise<T | null> {
  const { options, message, pageSize = 10, placeholder = "Type to filter options..." } = opts;

  if (options.length === 0) return null;

  // If there are very few options, skip the search step
  if (options.length <= 5) {
    const choice = await p.select({
      message,
      options: options.map((o) => ({
        value: o.value,
        label: o.hint ? `${o.label} ${pc.dim(o.hint)}` : o.label,
      })) as p.Option<T>[],
    });
    if (p.isCancel(choice)) return null;
    return choice as T;
  }

  const query = await p.text({
    message: `${message} ${pc.dim(`(${options.length} options, type to filter)`)}`,
    placeholder,
    defaultValue: "",
  });

  if (p.isCancel(query)) return null;

  const q = (query ?? "").toLowerCase().trim();

  let filtered: SearchableSelectOption<T>[];
  if (!q) {
    filtered = options.slice(0, pageSize);
  } else {
    filtered = options
      .map((o) => ({ option: o, score: rankMatch(q, o) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, pageSize)
      .map((r) => r.option);
  }

  if (filtered.length === 0) {
    p.log.warn(`No matches for "${q}"`);
    return null;
  }

  // If only one match, auto-select it
  if (filtered.length === 1 && q) {
    return filtered[0].value;
  }

  const choice = await p.select({
    message: q ? `Matches for "${q}"` : "Select an option",
    options: filtered.map((o) => ({
      value: o.value,
      label: o.hint ? `${o.label} ${pc.dim(o.hint)}` : o.label,
    })) as p.Option<T>[],
  });

  if (p.isCancel(choice)) return null;
  return choice as T;
}

export async function searchableConfirm(message: string): Promise<boolean> {
  const result = await p.confirm({ message, initialValue: true });
  if (p.isCancel(result)) return false;
  return result;
}
