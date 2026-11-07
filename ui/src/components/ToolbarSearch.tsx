import { t, useTranslation } from "@/i18n";
import type { Ref } from "react";
import { Search, X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/** Shared collection search field: one surface, focus ring and clear affordance. */
export function ToolbarSearch({ query, onQueryChange, label, placeholder, clearLabel = t("final-components-a:clearSearch_3b7ea517"), inputRef, inputType = "text" }: {
  query: string;
  onQueryChange: (value: string) => void;
  label: string;
  placeholder: string;
  clearLabel?: string;
  inputRef?: Ref<HTMLInputElement>;
  inputType?: "text" | "search";
}) {
  useTranslation("final-components-a");
  return <div className="design-task-search" data-toolbar-search>
    <Search aria-hidden />
    <Input ref={inputRef} type={inputType} aria-label={label} placeholder={placeholder} value={query} onChange={event => onQueryChange(event.target.value)} />
    {query && <Button variant="ghost" size="icon-xs" data-toolbar-clear aria-label={clearLabel} onClick={() => onQueryChange("")}><X aria-hidden /></Button>}
  </div>;
}
