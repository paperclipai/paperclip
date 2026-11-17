import * as React from "react"
import { Label as LabelPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { ANALYTICS_UNMASK_PROPS } from "@/lib/analytics/privacy"

function Label({
  className,
  analyticsChrome = false,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root> & {
  /** The text is fixed product copy, so session replay may show it. */
  analyticsChrome?: boolean
}) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      {...(analyticsChrome ? ANALYTICS_UNMASK_PROPS : {})}
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
