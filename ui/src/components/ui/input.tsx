import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // Base layout + typography
        "h-9 w-full min-w-0 px-3 py-1 text-base md:text-sm",
        "file:text-foreground placeholder:text-muted-foreground",
        "selection:bg-primary selection:text-primary-foreground",
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        // Glass surface — translucent, slightly blurred
        "rounded-lg border border-input",
        "bg-white/60 dark:bg-white/5",
        "backdrop-blur-md",
        "shadow-[0_1px_2px_rgb(0_0_0/0.08),inset_0_1px_0_0_rgb(255_255_255/0.10)]",
        "dark:shadow-[0_1px_2px_rgb(0_0_0/0.20),inset_0_1px_0_0_rgb(255_255_255/0.06)]",
        // Smooth transition including box-shadow for the glow effect
        "outline-none transition-[color,box-shadow,border-color] duration-200",
        // Focus: accent border + soft glow ring
        "focus-visible:border-ring",
        "focus-visible:ring-[3px] focus-visible:ring-ring/30",
        "focus-visible:shadow-[0_0_0_4px_color-mix(in_oklab,var(--ring)_20%,transparent),0_1px_2px_rgb(0_0_0/0.08)]",
        // Invalid state
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
