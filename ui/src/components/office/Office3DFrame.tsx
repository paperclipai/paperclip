import { useEffect, useRef, useState } from "react";
import { Building2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

const LOAD_TIMEOUT_MS = 8000;

// Embeds the real CLAW3D (Three.js) office in an iframe. The native 2.5D office
// is always the default; this is opt-in behind a flag and falls back to native
// if CLAW3D isn't running / can't be embedded, so a dead server is a non-event.
export function Office3DFrame({ url, onFallback }: { url: string; onFallback: () => void }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setStatus("loading");
    timerRef.current = window.setTimeout(() => {
      setStatus((prev) => (prev === "loading" ? "error" : prev));
    }, LOAD_TIMEOUT_MS);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [url]);

  if (status === "error") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Building2 className="h-8 w-8 text-muted-foreground/50" />
        <p className="max-w-sm text-sm text-muted-foreground">
          The 3D office (CLAW3D) at <span className="font-mono text-foreground">{url}</span> didn&rsquo;t load.
          It must be running and allow embedding from this origin.
        </p>
        <Button variant="outline" size="sm" onClick={onFallback}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          Back to 2.5D
        </Button>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <iframe
        src={url}
        title="CLAW3D Office"
        className="h-full w-full border-0"
        sandbox="allow-scripts allow-pointer-lock"
        allow="fullscreen"
        onLoad={() => {
          if (timerRef.current) window.clearTimeout(timerRef.current);
          setStatus("ready");
        }}
      />
      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 text-sm text-muted-foreground">
          Loading 3D office…
        </div>
      )}
    </div>
  );
}
