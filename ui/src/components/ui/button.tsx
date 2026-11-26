import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-150 active:brightness-95 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3) aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        cta: "bg-foreground text-background hover:bg-foreground/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-9 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-10",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-9",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> &
    VariantProps<typeof buttonVariants> & {
      asChild?: boolean
      loading?: boolean
    }
>(function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  disabled = false,
  onClick,
  ...props
}, ref) {
  const Comp = asChild ? Slot.Root : "button"
  const [asyncPending, setAsyncPending] = React.useState(false)
  const mountedRef = React.useRef(true)

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const isBusy = Boolean(loading || asyncPending)

  const handleClick: React.MouseEventHandler<HTMLButtonElement> = (event) => {
    if (isBusy) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    const result: unknown = onClick?.(event)
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      setAsyncPending(true)
      Promise.resolve(result).finally(() => {
        if (mountedRef.current) setAsyncPending(false)
      })
    }
  }

  return (
    <Comp
      ref={ref}
      {...props}
      disabled={asChild ? disabled : Boolean(disabled || isBusy)}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={isBusy ? "true" : undefined}
      aria-busy={isBusy || props["aria-busy"] ? true : undefined}
      onClick={asChild ? onClick : handleClick}
      className={cn(buttonVariants({ variant, size, className }))}
    />
  )
})

Button.displayName = "Button"

export { Button, buttonVariants }
