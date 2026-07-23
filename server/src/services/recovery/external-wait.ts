export interface ExternalWaitDetails {
  owner: string;
  action: string;
}

export function externalWaitFromDescription(
  description: string | null | undefined,
): ExternalWaitDetails | null {
  if (!description) return null;
  const owner = description.match(/^\s*external owner\s*:\s*(.+)$/im)?.[1]?.trim();
  const action = description.match(/^\s*external action\s*:\s*(.+)$/im)?.[1]?.trim();
  if (!owner || !action) return null;
  return {
    owner: owner.slice(0, 120),
    action: action.slice(0, 240),
  };
}

export function hasExternalWaitDescription(description: string | null | undefined) {
  return externalWaitFromDescription(description) !== null;
}
