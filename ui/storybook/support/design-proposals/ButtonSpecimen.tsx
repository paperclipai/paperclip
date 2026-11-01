import { useEffect, useRef, useState } from "react";
import { CirclePlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ButtonPlaygroundSettings, ButtonSize, ButtonVariant } from "./ButtonSamples";

type Measurements = { dimensions: string; type: string; padding: string; radius: string; icon: string; colors: string };
const round = (value: number) => Math.round(value * 10) / 10;

export function ButtonSpecimen({ settings, variant = settings.variant, size = settings.size, state = settings.state, onClick, measure = false }: {
  settings: ButtonPlaygroundSettings; variant?: ButtonVariant; size?: ButtonSize;
  state?: ButtonPlaygroundSettings["state"]; onClick: () => void; measure?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [measurements, setMeasurements] = useState<Measurements>();
  const iconOnly = size.startsWith("icon");
  const busy = state === "loading";
  const read = () => {
    const element = ref.current;
    if (!measure || !element) return;
    const box = element.getBoundingClientRect();
    const css = getComputedStyle(element);
    const icon = element.querySelector("svg")?.getBoundingClientRect();
    const next = {
      dimensions: `${round(box.width)} × ${round(box.height)}px`,
      type: `${css.fontSize} / ${css.lineHeight} · weight ${css.fontWeight}`,
      padding: `${css.paddingLeft} left · ${css.paddingRight} right · ${css.paddingTop} top · ${css.paddingBottom} bottom`,
      radius: css.borderRadius,
      icon: icon ? `${round(icon.width)} × ${round(icon.height)}px` : "None",
      colors: `${css.color} on ${css.backgroundColor}`,
    };
    setMeasurements(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  };
  useEffect(() => {
    if (!measure || !ref.current) return;
    let frame = requestAnimationFrame(read);
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(read); });
    observer.observe(ref.current);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [measure, variant, size, state, settings.icon, settings.label, settings.surface]);
  return <div className="min-w-0 space-y-3">
    <Button ref={ref} variant={variant} size={size} disabled={state === "disabled" || busy} aria-busy={busy || undefined}
      data-button-preview-state={state} aria-label={iconOnly ? settings.label : undefined} onClick={onClick}
      onMouseEnter={read} onMouseLeave={() => requestAnimationFrame(read)} onFocus={read} onBlur={() => requestAnimationFrame(read)} onTransitionEnd={read}>
      {busy ? <Loader2 aria-hidden className="animate-spin" /> : iconOnly || settings.icon === "leading" ? <CirclePlus aria-hidden /> : null}
      {!iconOnly ? settings.label : null}
      {!busy && !iconOnly && settings.icon === "trailing" ? <CirclePlus aria-hidden /> : null}
    </Button>
    {measurements && <>
      <output className="block text-xs text-muted-foreground" data-testid="button-pixel-size">{measurements.dimensions}</output>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Computed style</summary>
        <dl className="mt-2 space-y-2" aria-label="Button measurements">
          {Object.entries({ Typography: measurements.type, Padding: measurements.padding, Radius: measurements.radius, Icon: measurements.icon, Colors: measurements.colors }).map(([label, value]) => <div key={label}><dt className="font-normal text-foreground">{label}</dt><dd className="break-words">{value}</dd></div>)}
        </dl>
      </details>
    </>}
  </div>;
}
