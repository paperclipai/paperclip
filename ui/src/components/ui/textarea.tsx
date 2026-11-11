import * as React from "react"

import { cn } from "@/lib/utils"
import { useTx, withTranslatedTextProps } from "@/i18n/tx"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  const tx = useTx()
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 min-w-0 w-full max-w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-(--tp-color-box-shadow) outline-none focus-visible:ring-(length:--rad-3) disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...withTranslatedTextProps(tx, props)}
    />
  )
}

export { Textarea }
