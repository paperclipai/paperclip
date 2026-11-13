import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { ButtonSamples, buttonSizes, buttonStates, buttonSurfaces, buttonVariants, defaultButtonSettings, type ButtonPlaygroundSettings } from "./ButtonSamples";

export type ButtonsPlaygroundProps = ButtonPlaygroundSettings & {
  onSettingsChange?: (settings: Partial<ButtonsPlaygroundProps>) => void;
};

export function ButtonsPlayground({ onSettingsChange, ...settings }: ButtonsPlaygroundProps) {
  const [sizeHeights, setSizeHeights] = useState<Record<string, number>>({});
  useEffect(() => {
    const buttons = document.querySelectorAll<HTMLElement>('[data-testid="proposal-button-samples"] [data-button-size] [data-slot="button"]');
    const measure = () => {
      const next = Object.fromEntries(Array.from(buttons, button => [button.dataset.size!, Math.round(button.getBoundingClientRect().height * 10) / 10]));
      setSizeHeights(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    let frame = 0;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); });
    buttons.forEach(button => observer.observe(button));
    measure();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  return <main id="button-playground-top" data-testid="buttons-playground" className="min-h-screen bg-background px-6 py-10 text-foreground">
    <div className="mx-auto max-w-7xl space-y-10">
      <header className="space-y-3">
        <p className="text-xs text-muted-foreground">Paperclip · Design proposals · Components</p>
        <h1 className="text-3xl font-semibold">Buttons playground</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">Style the buttons and contextual controls used in the design sandbox. Every example uses its shared component with the sandbox’s proposal theme. Hover and Tab through the controls; actions use local fixture state.</p>
      </header>
      <fieldset className="sticky top-0 z-20 flex flex-wrap items-end gap-4 rounded-lg border border-border bg-background p-4" aria-label="Button playground controls">
        <label className="flex flex-col gap-2 text-xs text-muted-foreground">Label
          <Input aria-label="Button label" value={settings.label} maxLength={80} onChange={event => onSettingsChange?.({ label: event.target.value })} className="w-48" />
        </label>
        <label className="flex flex-col gap-2 text-xs text-muted-foreground">Style
          <NativeSelect aria-label="Button variant" value={settings.variant} onChange={event => onSettingsChange?.({ variant: event.target.value as ButtonsPlaygroundProps["variant"] })}>
            {Object.entries(buttonVariants).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-2 text-xs text-muted-foreground">Size
          <NativeSelect aria-label="Button size" value={settings.size} onChange={event => onSettingsChange?.({ size: event.target.value as ButtonsPlaygroundProps["size"] })}>
            {Object.entries(buttonSizes).map(([value, label]) => <option key={value} value={value}>{label}{sizeHeights[value] ? ` · ${sizeHeights[value]}px high` : ""}</option>)}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-2 text-xs text-muted-foreground">Icon
          <NativeSelect aria-label="Button icon" value={settings.icon} onChange={event => onSettingsChange?.({ icon: event.target.value as ButtonsPlaygroundProps["icon"] })}>
            <option value="none">None</option><option value="leading">Leading</option><option value="trailing">Trailing</option>
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-2 text-xs text-muted-foreground">Specimen state
          <NativeSelect aria-label="Button state" value={settings.state} onChange={event => onSettingsChange?.({ state: event.target.value as ButtonsPlaygroundProps["state"] })}>
            {Object.entries(buttonStates).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-2 text-xs text-muted-foreground">Preview surface
          <NativeSelect aria-label="Button surface" value={settings.surface} onChange={event => onSettingsChange?.({ surface: event.target.value as ButtonsPlaygroundProps["surface"] })}>
            {Object.entries(buttonSurfaces).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </NativeSelect>
        </label>
        <Button variant="outline" onClick={() => onSettingsChange?.(defaultButtonSettings)}>Reset controls</Button>
        <p className="w-full text-xs text-muted-foreground">Size labels show measured heights. Specimens report their actual width, padding, typography, icon size and colors. The inventory below uses the full available width.</p>
      </fieldset>
      <section className="min-w-0 space-y-6" aria-labelledby="sandbox-buttons-title">
        <header className="space-y-2"><h2 id="sandbox-buttons-title" className="text-2xl font-semibold">Sandbox buttons</h2>
          <p className="text-sm text-muted-foreground">Shared styles and sizes, followed by task, navigation, pane, agent, conversation and attachment controls in context.</p>
        </header>
        <ButtonSamples settings={settings} />
      </section>
      <p className="text-xs leading-relaxed text-muted-foreground">Scope: the sandbox’s shared button styles and sizes, plus the contextual controls shown here. Examples use synthetic data and local callbacks; they do not run agents, upload files or persist product changes. This is a styling workbench, not a repository-wide usage audit.</p>
    </div>
  </main>;
}
