import * as React from "react"
import { Label as LabelPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { translateTextNode, useTx, withTranslatedTextProps } from "@/i18n/tx"

function Label({
  className,
  children,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  const tx = useTx()
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...withTranslatedTextProps(tx, props)}
    >
      {translateTextNode(tx, children)}
    </LabelPrimitive.Root>
  )
}

export { Label }
