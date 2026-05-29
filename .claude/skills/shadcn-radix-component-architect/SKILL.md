---
name: shadcn-radix-component-architect
description: Design and implement accessible component architectures with shadcn/ui + Radix primitives. Use when building dialog, command-menu, combobox, popover, dropdown, or any composite component that needs keyboard semantics, focus traps, and slot composition. Avoids the generic "stock shadcn" look by enforcing a distinctive design pass.
category: frontend
version: 0.1.0
tags: [react, shadcn, radix, tailwind, component, a11y]
recommended_npm: ["@radix-ui/react-dialog", "@radix-ui/react-popover", "@radix-ui/react-dropdown-menu", "class-variance-authority", "tailwind-merge", "lucide-react", "cmdk"]
license: MIT
author: claude-code-skills
---

You build composite UI components by composing Radix primitives with Tailwind utility classes through the shadcn/ui pattern. The goal is **owned source code in the user's repo**, not a black-box dependency.

## Decision tree before coding

1. Does Radix have a primitive for this interaction? → Use it. Never roll your own focus trap, escape-key handler, or scroll-lock.
2. Is the visible variant set finite (size × intent × state)? → Encode with `cva` (`class-variance-authority`).
3. Will this component appear in 3+ places? → Generate it under `components/ui/<name>.tsx`. Otherwise inline.

## Composition rules

- **Compose Radix anatomy fully.** A `Dialog` is `Root` + `Trigger` + `Portal` + `Overlay` + `Content` + `Title` + `Description` + `Close`. Skipping `Title` breaks screen readers; skipping `Portal` breaks z-index in nested layouts.
- **Use `asChild` for slot inheritance.** `<DropdownMenu.Trigger asChild><Button>…</Button></DropdownMenu.Trigger>` keeps Button's full API.
- **Variant API.** `cva(base, { variants, defaultVariants, compoundVariants })`. Never use ad-hoc string concatenation for class names — go through `cn()` (clsx + tailwind-merge).
- **Forward refs.** Every component that wraps a Radix primitive must `React.forwardRef` and pass `ref` through, or composition breaks (popovers, tooltips).

## Avoiding the generic shadcn look

Stock shadcn is everywhere. To stand out:
- Replace the default border radius (`--radius: 0.5rem`) — go either sharp (0.125rem) or oversized (1rem+).
- Replace Inter with a distinctive display font (Geist Mono, Söhne, JetBrains, Space Grotesk, IBM Plex Serif).
- Layer the background: `bg-[radial-gradient(...)] bg-fixed` plus a noise SVG overlay at 4% opacity.
- Use one accent color with high saturation as a sharp contrast against an otherwise muted palette.
- Add a single signature animation — e.g. a spring-based `Popover` that scales from `0.96` to `1.0` with overshoot.

## File layout

```
components/
  ui/
    button.tsx         # cva variants, forwardRef, asChild
    dialog.tsx         # Radix Dialog composition
    command.tsx        # cmdk + Dialog
    dropdown-menu.tsx
  blocks/              # higher-level compositions you assemble
    settings-dialog.tsx
lib/
  cn.ts                # cn = (...args) => twMerge(clsx(args))
```

## Anti-patterns

- ❌ Reaching into Radix internals via `data-state` selectors instead of the documented props.
- ❌ Wrapping every Radix primitive in your own component just to add one prop. Extend with `cva` variants on existing wrappers instead.
- ❌ Using `useEffect` to manage open/close state — use Radix controlled props (`open`, `onOpenChange`).
- ❌ Mixing Radix Dialog with HeadlessUI Combobox in the same screen — pick one ecosystem.

## Quality gate before shipping

- Tab order navigates through every interactive element in DOM order, no skips.
- `Esc` closes overlays in nested order.
- Screen reader announces the component role and label (test with VoiceOver / NVDA).
- The component looks intentional in dark mode without separate dark-only overrides.
- No layout shift when opening (use `Portal` + fixed positioning).
