import { useTranslation } from "@/i18n";
import { useState, type ReactNode } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { SidePanelLauncherItem, SidePanelLauncherSection } from "./types";

export interface SidePanelLauncherProps {
  sections: SidePanelLauncherSection[];
  onSelect: (item: SidePanelLauncherItem) => void;
  presentation?: "panel" | "popover";
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: string;
  description?: string;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
}

function LauncherContent({
  sections,
  onSelect,
  placeholder,
  emptyMessage,
  panel,
}: Pick<SidePanelLauncherProps, "sections" | "onSelect" | "placeholder" | "emptyMessage"> & { panel: boolean }) {
  const { t } = useTranslation();
  return (
    <Command className={cn(panel && "border border-border shadow-sm")}>
      <CommandInput placeholder={placeholder} aria-label={placeholder} />
      <CommandList className={cn(panel && "max-h-none flex-1")}>
        <CommandEmpty>{emptyMessage}</CommandEmpty>
        {sections.map((section, sectionIndex) => (
          <div key={section.id}>
            {sectionIndex > 0 ? <CommandSeparator /> : null}
            <CommandGroup heading={section.label}>
              {section.loading ? (
                <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground" role="status">
                  <Loader2 className="size-4 animate-spin" aria-hidden />{t("localizationCommonChrome.loading")}</div>
              ) : null}
              {section.error ? (
                <div className="flex items-start gap-2 px-2 py-3 text-sm text-muted-foreground" role="status">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>{section.error}</span>
                </div>
              ) : null}
              {section.items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={`${item.label} ${item.description ?? ""} ${item.searchText ?? ""}`}
                  disabled={item.disabled}
                  title={item.disabledReason}
                  onSelect={() => onSelect(item)}
                  className="min-h-10"
                >
                  {item.icon ? <span className="flex size-4 shrink-0 items-center justify-center">{item.icon}</span> : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.label}</span>
                    {(item.description || item.disabledReason) ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.disabledReason ?? item.description}
                      </span>
                    ) : null}
                  </span>
                  {item.alreadyOpen ? <Check className="size-4 text-muted-foreground" aria-label={t("localizationCommonChrome.alreadyOpen")} /> : null}
                  {item.shortcut ? <CommandShortcut>{item.shortcut}</CommandShortcut> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </div>
        ))}
      </CommandList>
    </Command>
  );
}

export function SidePanelLauncher({
  sections,
  onSelect,
  presentation = "panel",
  trigger,
  open: controlledOpen,
  onOpenChange,
  title,
  description,
  placeholder,
  emptyMessage,
  className,
}: SidePanelLauncherProps) {
  const { t } = useTranslation();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const content = (
    <LauncherContent
      sections={sections}
      onSelect={(item) => {
        onSelect(item);
        if (presentation === "popover") setOpen(false);
      }}
      placeholder={placeholder ?? t("localizationCommonChrome.searchPanelResources")}
      emptyMessage={emptyMessage ?? t("localizationCommonChrome.noPanelResources")}
      panel={presentation === "panel"}
    />
  );

  if (presentation === "popover") {
    if (!trigger) return null;
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent align="start" className={cn("w-(--side-panel-launcher-width) overflow-hidden p-0", className)}>
          <div className="sr-only">
            <h2>{title ?? t("localizationCommonChrome.openPanelTab")}</h2>
            <p>{description ?? t("localizationCommonChrome.choosePanelResource")}</p>
          </div>
          {content}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <div className={cn("mx-auto flex h-full w-full max-w-xl flex-col justify-center gap-4 p-4", className)}>
      <div className="space-y-1 text-center">
        <h2 className="text-sm font-semibold">{title ?? t("localizationCommonChrome.openPanelTab")}</h2>
        <p className="text-sm text-muted-foreground">{description ?? t("localizationCommonChrome.choosePanelResource")}</p>
      </div>
      {content}
    </div>
  );
}
