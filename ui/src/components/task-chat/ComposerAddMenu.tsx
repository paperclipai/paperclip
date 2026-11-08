import { t, useTranslation } from "@/i18n";
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
  useTranslation("task-components");
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
    ...(onAttachFile ? [{ id: "composer-add-file", label: t("task-components:filesAndImages_bad8aa9e"), Icon: Paperclip, select: onAttachFile, disabled: attachDisabled }] : []),
    ...(privacy ? [{ id: "composer-add-private", label: t("task-components:privateTask_8d52cb21"), detail: privacy.inherited, Icon: Lock, select: () => privacy.onChange(!privacy.private), selected: privacy.private, disabled: Boolean(privacy.inherited) }] : []),
    ...(onGoal ? [{ id: "composer-add-goal", label: t("task-components:goal_cdbf6975"), detail: t("task-chat-ui:keepPursuing"), Icon: Target, select: onGoal }] : []),
    ...(onModeChange ? [
      { id: "composer-add-plan", label: t("task-components:planMode_3ca7d842"), detail: t("task-chat-ui:planBeforeActing"), Icon: ClipboardList, select: () => onModeChange(mode === "planning" ? "standard" : "planning"), selected: mode === "planning" },
      { id: "composer-add-ask", label: t("task-components:askMode_ae649982"), detail: t("task-chat-ui:answerWithoutChanges"), Icon: MessageCircleQuestion, select: () => onModeChange(mode === "ask" ? "standard" : "ask"), selected: mode === "ask" },
    ] : []),
  ];
  const trigger = <button type="button" aria-label={t("task-components:addToComposer_423f6a56")} aria-keyshortcuts={onModeChange ? "Meta+Period Control+Period Shift+Tab" : undefined}
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
        <DialogTitle className="min-w-0 flex-1 text-sm font-medium">{t("task-components:add_9fd728c6")}</DialogTitle>
        <DialogClose asChild><button type="button" aria-label={t("task-components:closeAddMenu_b4ae95cd")} className="grid size-11 place-items-center rounded-md text-muted-foreground hover:bg-accent"><X className="size-4" /></button></DialogClose>
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
      <div className="px-2 py-1 text-xs text-muted-foreground">{t("task-components:add_9fd728c6")}</div>
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
  useTranslation("task-components");
  if (mode === "standard") return null;
  const meta = workModeMetaFor(mode);
  const Icon = meta.icon;
  return <button type="button" onClick={onRemove} disabled={disabled || !onRemove}
    aria-label={t("task-components:remove_d2f6b9b7", { value1: meta.label })} data-pending-work-mode={mode} data-testid={testId}
    className={cn("inline-flex h-8 shrink-0 items-center rounded-full border text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", mobile ? "gap-1 px-2" : "gap-1 px-2 sm:gap-1.5 sm:px-2.5", meta.classes.chip)}>
    <Icon className="size-3.5" aria-hidden />
    <span className={mobile ? "sr-only" : "max-sm:sr-only"}>{meta.label}</span>
    <X className="size-3.5" aria-hidden />
  </button>;
}

export function ComposerPrivacyChip({ inherited, onRemove, disabled }: { inherited?: string; onRemove: () => void; disabled?: boolean }) {
  useTranslation("task-components");
  const [hintOpen, setHintOpen] = useState(false);
  const explanation = inherited ?? t("task-chat-ui:privateExplanation");
  return <TooltipProvider><Tooltip open={hintOpen} onOpenChange={setHintOpen}>
    <TooltipTrigger asChild>
      <span className="inline-flex shrink-0" role={inherited ? "button" : undefined}
        tabIndex={inherited ? 0 : undefined} aria-label={inherited ? explanation : undefined}
        onClick={inherited ? (event) => { event.preventDefault(); setHintOpen(true); } : undefined}
        onKeyDown={inherited ? (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setHintOpen(true); }
        } : undefined}>
        <button type="button" onClick={onRemove} aria-label={inherited ? t("task-components:privateTask_8d52cb21") : t("task-components:removePrivateTask_ba572379")}
          title={explanation}
          disabled={disabled || Boolean(inherited)} data-testid="composer-private-chip"
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-2 text-xs font-medium text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
          <Lock className="size-3.5" aria-hidden />
          <span className="max-sm:sr-only">{t("task-components:private_c63eb672")}</span>
          {!inherited ? <X className="size-3.5" aria-hidden /> : null}
        </button>
      </span>
    </TooltipTrigger>
    <TooltipContent className="max-w-xs">{explanation}</TooltipContent>
  </Tooltip></TooltipProvider>;
}
