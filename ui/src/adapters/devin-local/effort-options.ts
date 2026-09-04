// Devin effort tiers are per model family: the adapter reports each base
// model's supported tiers on the models route (`AdapterModel.efforts`), and
// the board's Thinking effort dropdown offers only those plus Auto.
// EFFORT_TIER_LABELS supplies display labels for tiers the catalog can return.

export interface DevinEffortOption {
  id: string;
  label: string;
}

const EFFORT_TIER_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  thinking: "Thinking",
};

export function buildDevinEffortOptions(
  efforts: string[] | undefined,
  currentValue: string,
): DevinEffortOption[] {
  const tiers = (efforts ?? []).filter((e) => e !== "auto");
  const options: DevinEffortOption[] = [
    { id: "", label: "Auto" },
    ...tiers.map((e) => ({ id: e, label: EFFORT_TIER_LABELS[e] ?? e })),
  ];
  // A stored value the selected family does not offer stays visible (flagged)
  // instead of silently rendering as Auto; the run rejects it.
  if (currentValue && !options.some((o) => o.id === currentValue)) {
    options.push({
      id: currentValue,
      label: `${EFFORT_TIER_LABELS[currentValue] ?? currentValue} (not available for this model)`,
    });
  }
  return options;
}
