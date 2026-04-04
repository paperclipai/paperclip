import type { AdapterConfigFieldsProps } from "../types";

export function PollConfigFields(_props: AdapterConfigFieldsProps) {
  return (
    <p className="text-xs text-muted-foreground">
      No configuration needed. This agent polls the Paperclip API for tasks and
      manages its own execution lifecycle.
    </p>
  );
}
