import * as React from "react"

import { cn } from "@/lib/utils"

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        // Base layout
        "bg-card text-card-foreground flex flex-col gap-6 border py-6",
        // Liquid-glass: larger radius, layered soft shadow
        "rounded-2xl",
        "shadow-[0_4px_16px_rgb(0_0_0/0.22),0_1px_4px_rgb(0_0_0/0.12),0_0_0_1px_rgb(0_0_0/0.08)]",
        // Inner-top highlight via inset box-shadow (white shimmer at card top edge)
        "[box-shadow:0_4px_16px_rgb(0_0_0/0.22),0_1px_4px_rgb(0_0_0/0.12),inset_0_1px_0_0_rgb(255_255_255/0.08)]",
        // Dark-mode lifts the inner highlight slightly
        "dark:[box-shadow:0_4px_16px_rgb(0_0_0/0.32),0_1px_4px_rgb(0_0_0/0.18),inset_0_1px_0_0_rgb(255_255_255/0.08)]",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-6", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
