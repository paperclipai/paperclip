import { useCallback, useState } from "react";

export type SkillsLayout = "cards" | "list";

export const SKILLS_LAYOUT_PARAM = "layout";
export const SKILLS_LAYOUT_STORAGE_KEY = "paperclip:skills-layout";

function parseSkillsLayout(value: string | null | undefined): SkillsLayout | null {
  return value === "cards" || value === "list" ? value : null;
}

/** The shareable URL wins, then the browser's saved choice, then cards. */
export function resolveSkillsLayout(param: string | null, stored: string | null): SkillsLayout {
  return parseSkillsLayout(param) ?? parseSkillsLayout(stored) ?? "cards";
}

export function withSkillsLayout(current: URLSearchParams, layout: SkillsLayout): URLSearchParams {
  const params = new URLSearchParams(current);
  params.set(SKILLS_LAYOUT_PARAM, layout);
  return params;
}

function readStoredSkillsLayout(): string | null {
  try {
    return localStorage.getItem(SKILLS_LAYOUT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function useSkillsLayout(
  searchParams: URLSearchParams,
  setSearchParams: (
    next: (current: URLSearchParams) => URLSearchParams,
    options?: { replace?: boolean },
  ) => void,
): [SkillsLayout, (layout: SkillsLayout) => void] {
  const [stored, setStored] = useState(readStoredSkillsLayout);
  const layout = resolveSkillsLayout(searchParams.get(SKILLS_LAYOUT_PARAM), stored);
  const setLayout = useCallback((next: SkillsLayout) => {
    try {
      localStorage.setItem(SKILLS_LAYOUT_STORAGE_KEY, next);
    } catch {
      // Private browsing can refuse storage; the URL still carries the choice.
    }
    setStored(next);
    setSearchParams((current) => withSkillsLayout(current, next), { replace: true });
  }, [setSearchParams]);
  return [layout, setLayout];
}
