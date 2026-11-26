import type { ReactNode } from "react";
import type { SearchableSelectOption } from "./SearchableSelect";

export interface AccessSelectOption extends SearchableSelectOption {
  identity: ReactNode;
}

export function renderAccessIdentity(option: AccessSelectOption | null) {
  return option ? <span className="flex min-w-0 items-center gap-2">{option.identity}</span> : null;
}
