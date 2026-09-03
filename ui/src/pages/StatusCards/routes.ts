export const statusCardTabs = ["summary", "settings", "watched", "history"] as const;

export type StatusCardTab = (typeof statusCardTabs)[number];

export function isStatusCardTab(value: string | undefined): value is StatusCardTab {
  return statusCardTabs.includes(value as StatusCardTab);
}

export function statusCardPath(cardId: string, tab: StatusCardTab = "summary"): string {
  return `/status/${cardId}/${tab}`;
}
