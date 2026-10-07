import { useEffect, useRef, useState } from "react";
import type { IssueWorkMode } from "@paperclipai/shared";
import { Check, ClipboardList, MessageCircleQuestion, Lock, Paperclip, Plus, Target, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMobileEntityPickerViewportStyle } from "@/hooks/useMobileEntityPickerViewportStyle";
import { workModeMetaFor } from "@/lib/work-mode-meta";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import "./composer-run-settings.css";

const MOBILE_SHELL_QUERY = "(max-width: 767px)";

interface ComposerAddMenuProps {
  mode: IssueWorkMode;
  onModeChange?: (mode: IssueWorkMode) => void;
  onAttachFile?: () => void;
  attachDisabled?: boolean;
  onGoal?: () => void;
  privacy?: { private: boolean; inherited?: string; onChange: (value: boolean) => void };
  disabled?: boolean;
  mobile?: boolean;
  triggerTestId?: string;
  menuTestId?: string;
}

export function ComposerAddMenu({
  mode, onModeChange, onAttachFile, attachDisabled, onGoal, privacy, disabled, mobile: mobileProp, triggerTestId, menuTestId,
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);
  const mobileViewportStyle = useMobileEntityPickerViewportStyle();
  const goalFocusRef = useRef(false);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MOBILE_SHELL_QUERY).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(MOBILE_SHELL_QUERY);
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const mobile = mobileProp ?? narrow;
  if (!onModeChange && !onAttachFile && !onGoal && !privacy) return null;
  const actions: Array<{ id: string; label: string; detail?: string; Icon: LucideIcon; select: () => void; disabled?: boolean; selected?: boolean }> = [
    ...(onAttachFile ? [{ id: "composer-add-file", label: "Files and images", Icon: Paperclip, select: onAttachFile, disabled: attachDisabled }] : []),
    ...(privacy ? [{ id: "composer-add-private", label: "Private task", detail: privacy.inherited, Icon: Lock, select: () => privacy.onChange(!privacy.private), selected: privacy.private, disabled: Boolean(privacy.inherited) }] : []),
    ...(onGoal ? [{ id: "composer-add-goal", label: "Goal", detail: "Keep pursuing", Icon: Target, select: onGoal }] : []),
    ...(onModeChange ? [
      { id: "composer-add-plan", label: "Plan mode", detail: "Plan before acting", Icon: ClipboardList, select: () => onModeChange(mode === "planning" ? "standard" : "planning"), selected: mode === "planning" },
      { id: "composer-add-ask", label: "Ask mode", detail: "Answer without changes", Icon: MessageCircleQuestion, select: () => onModeChange(mode === "ask" ? "standard" : "ask"), selected: mode === "ask" },
    ] : []),
  ];
  const trigger = <button type="button" aria-label="Add to composer" aria-keyshortcuts={onModeChange ? "Meta+Period Control+Period Shift+Tab" : undefined}
    disabled={disabled} data-testid={triggerTestId}
    className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
    <Plus className="size-4" aria-hidden />
  </button>;
  const content = (action: typeof actions[number]) => <>
    <action.Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    <span className="flex min-w-0 flex-1 items-baseline gap-2"><span>{action.label}</span>{action.detail ? <span className="truncate text-xs text-muted-foreground">{action.detail}</span> : null}</span>
    {action.selected ? <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
  </>;
  if (mobile) return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>{trigger}</DialogTrigger>
    <DialogContent aria-describedby={undefined} showCloseButton={false} data-testid={menuTestId} style={mobileViewportStyle}
      onCloseAutoFocus={(event) => { if (goalFocusRef.current) { event.preventDefault(); goalFocusRef.current = false; } }}
      className="composer-mobile-dialog flex flex-col translate-y-0 gap-0 overflow-hidden p-0 md:translate-y-0">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <DialogTitle className="min-w-0 flex-1 text-sm font-medium">Add</DialogTitle>
        <DialogClose asChild><button type="button" aria-label="Close Add menu" className="grid size-11 place-items-center rounded-md text-muted-foreground hover:bg-accent"><X className="size-4" /></button></DialogClose>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain p-2 pt-0">{actions.map((action) => <button key={action.id} type="button" disabled={action.disabled} data-testid={action.id}
        onClick={() => { goalFocusRef.current = action.id === "composer-add-goal"; action.select(); setOpen(false); }}
        className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
        {content(action)}
      </button>)}</div>
    </DialogContent>
  </Dialog>;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start" sideOffset={8} data-testid={menuTestId}
      className="w-(--sz-300px) rounded-xl p-1.5 shadow-sm">
      <div className="px-2 py-1 text-xs text-muted-foreground">Add</div>
      {actions.map((action) => <DropdownMenuItem key={action.id} onSelect={action.select} disabled={action.disabled} data-testid={action.id}>
        {content(action)}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

interface ComposerModeChipProps {
  mode: IssueWorkMode;
  onRemove?: () => void;
  disabled?: boolean;
  testId?: string;
  mobile?: boolean;
}

export function ComposerModeChip({ mode, onRemove, disabled, testId, mobile = false }: ComposerModeChipProps) {
  if (mode === "standard") return null;
  const meta = workModeMetaFor(mode);
  const Icon = meta.icon;
  return <button type="button" onClick={onRemove} disabled={disabled || !onRemove}
    aria-label={`Remove ${meta.label}`} data-pending-work-mode={mode} data-testid={testId}
    className={cn("inline-flex h-8 shrink-0 items-center rounded-full border text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", mobile ? "gap-1 px-2" : "gap-1 px-2 sm:gap-1.5 sm:px-2.5", meta.classes.chip)}>
    <Icon className="size-3.5" aria-hidden />
    <span className={mobile ? "sr-only" : "max-sm:sr-only"}>{meta.label}</span>
    <X className="size-3.5" aria-hidden />
  </button>;
}

export function ComposerPrivacyChip({ inherited, onRemove, disabled }: { inherited?: string; onRemove: () => void; disabled?: boolean }) {
  const [hintOpen, setHintOpen] = useState(false);
  const explanation = inherited ?? "Only you and people you share with can read this task";
  return <TooltipProvider><Tooltip open={hintOpen} onOpenChange={setHintOpen}>
    <TooltipTrigger asChild>
      <span className="inline-flex shrink-0" tabIndex={inherited ? 0 : undefined} aria-label={inherited ? explanation : undefined}
        onClick={inherited ? (event) => { event.preventDefault(); setHintOpen(true); } : undefined}
        onKeyDown={inherited ? (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setHintOpen(true); }
        } : undefined}>
        <button type="button" onClick={onRemove} aria-label={inherited ? "Private task" : "Remove private task"}
          title={explanation}
          disabled={disabled || Boolean(inherited)} data-testid="composer-private-chip"
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-2 text-xs font-medium text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
          <Lock className="size-3.5" aria-hidden />
          <span className="max-sm:sr-only">Private</span>
          {!inherited ? <X className="size-3.5" aria-hidden /> : null}
        </button>
      </span>
    </TooltipTrigger>
    <TooltipContent className="max-w-xs">{explanation}</TooltipContent>
  </Tooltip></TooltipProvider>;
}
