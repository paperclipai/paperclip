import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  disablePortal = false,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & { disablePortal?: boolean }) {
  const content = (
    <PopoverPrimitive.Content
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      className={cn(
        // Animation
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        // Layout
        "z-50 w-72 origin-(--radix-popover-content-transform-origin) outline-hidden p-4",
        // Glass surface
        "text-popover-foreground",
        "bg-popover/80 dark:bg-popover/70",
        "backdrop-blur-2xl",
        "rounded-xl",
        "border border-black/5 dark:border-white/10",
        // Layered shadow
        "shadow-[0_4px_16px_rgb(0_0_0/0.18),0_1px_4px_rgb(0_0_0/0.10),inset_0_1px_0_0_rgb(255_255_255/0.08)]",
        "dark:shadow-[0_4px_16px_rgb(0_0_0/0.36),0_1px_4px_rgb(0_0_0/0.18),inset_0_1px_0_0_rgb(255_255_255/0.06)]",
        className
      )}
      {...props}
    />
  )
  if (disablePortal) return content
  return <PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal>
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
}
