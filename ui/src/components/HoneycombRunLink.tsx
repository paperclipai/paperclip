import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildHoneycombRunUrl } from "@/lib/honeycomb-run-link";

export function HoneycombRunLink({
  runId,
  enabled,
}: {
  runId: string;
  enabled: boolean;
}) {
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!enabled) {
      setHref(null);
      return () => {
        active = false;
      };
    }

    void buildHoneycombRunUrl(runId)
      .then((url) => {
        if (active) setHref(url);
      })
      .catch(() => {
        if (active) setHref(null);
      });

    return () => {
      active = false;
    };
  }, [enabled, runId]);

  if (!enabled || !href) return null;

  return (
    <Button asChild variant="ghost" size="xs">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title="Open this run's task.run trace query in Honeycomb"
      >
        <ExternalLink />
        View in Honeycomb
      </a>
    </Button>
  );
}
