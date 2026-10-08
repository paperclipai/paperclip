import * as React from "react"
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { Select as SelectPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"

export const nativeSelectClassName = "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"

export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return <select {...props} className={cn(nativeSelectClassName, className)} />
}

// Shared with searchable picker triggers so their size and states match Select.
export const selectTriggerClassName = "border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 dark:hover:bg-input/50 flex w-fit items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-base md:text-sm whitespace-nowrap shadow-xs transition-(--tp-color-box-shadow) outline-none focus-visible:ring-(length:--rad-3) disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

export interface SelectPopoverOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
  suffix?: React.ReactNode;
  group?: string;
}

/** The harness picker surface, shared by simple and searchable configuration pickers. */
export function SelectPopover({
  value,
  onValueChange,
  options = [],
  placeholder = "Select…",
  displayValue,
  "aria-label": ariaLabel,
  "aria-busy": ariaBusy,
  disabled,
  className,
  open: controlledOpen,
  onOpenChange,
  onCloseAutoFocus,
  children,
}: {
  value: string;
  onValueChange?: (value: string) => void;
  options?: readonly SelectPopoverOption[];
  placeholder?: string;
  displayValue?: React.ReactNode;
  "aria-label": string;
  "aria-busy"?: boolean;
  disabled?: boolean;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: React.ComponentProps<typeof PopoverContent>["onCloseAutoFocus"];
  children?: React.ReactNode;
}) {
  const [localOpen, setLocalOpen] = React.useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  const contentRef = React.useRef<HTMLDivElement>(null);
  const selected = options.find(option => option.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={ariaLabel} aria-haspopup="listbox"
          aria-busy={ariaBusy}
          disabled={disabled} data-size="default"
          onKeyDown={event => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
            }
          }}
          className={cn(selectTriggerClassName, "w-full min-w-0", className)}>
          <span className="min-w-0 truncate text-left">{displayValue ?? selected?.label ?? (value || placeholder)}</span>
          <ChevronDownIcon className="size-4 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent ref={contentRef} align="start"
        onCloseAutoFocus={onCloseAutoFocus}
        className="w-(--radix-popover-trigger-width) max-h-(--radix-popover-content-available-height) overflow-y-auto p-1"
        onOpenAutoFocus={event => {
          if (contentRef.current?.querySelector("input:not(:disabled)")) return;
          event.preventDefault();
          (contentRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled)')
            ?? contentRef.current?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)'))?.focus();
        }}
        onKeyDown={event => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
            || (event.target instanceof HTMLInputElement && ["Home", "End"].includes(event.key))) return;
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
          if (!items.length) return;
          event.preventDefault();
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : current < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1)
            : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}>
        {children ?? <div role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => <React.Fragment key={option.value}>
            {option.group && option.group !== options[index - 1]?.group && <div className="px-2 py-1 text-xs text-muted-foreground">{option.group}</div>}
            <SelectPopoverItem data-value={option.value} selected={option.value === value}
            disabled={option.disabled} onClick={() => { onValueChange?.(option.value); setOpen(false); }}>
            <span className="min-w-0 truncate">{option.label}</span>
            {option.suffix}
          </SelectPopoverItem></React.Fragment>)}
        </div>}
      </PopoverContent>
    </Popover>
  );
}

export function SelectPopoverItem({ selected, className, ...props }: React.ComponentProps<"button"> & { selected?: boolean }) {
  return <button {...props} type="button" role="option" aria-selected={selected ?? false}
    className={cn("flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm outline-none hover:bg-accent/50 focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-40", selected && "bg-accent", className)} />;
}

function Select({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

function SelectGroup({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        selectTriggerClassName,
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = "item-aligned",
  align = "center",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 max-h-(--radix-select-content-available-height) min-w-(--sz-8rem) origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border shadow-md",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className
        )}
        position={position}
        align={align}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" &&
              "h-(--radix-select-trigger-height) w-full min-w-(--radix-select-trigger-width) scroll-my-1"
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("text-muted-foreground px-2 py-1.5 text-xs", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <span
        data-slot="select-item-indicator"
        className="absolute right-2 flex size-3.5 items-center justify-center"
      >
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("bg-border pointer-events-none -mx-1 my-1 h-px", className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className
      )}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className
      )}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
