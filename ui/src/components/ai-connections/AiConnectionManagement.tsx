import { Button } from "@/components/ui/button";

export function AiConnectionLegacyNotice({
  onAdopt,
  readOnly = false,
}: {
  onAdopt: () => void;
  readOnly?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">
        Existing authentication — not managed by Connections
      </h3>
      <p className="text-sm text-muted-foreground">
        This agent keeps its current authentication until you choose and test a
        managed connection. Confirm the account and who may use it before
        adopting.
      </p>
      {!readOnly && (
        <Button variant="outline" className="self-start" onClick={onAdopt}>
          Choose a managed connection
        </Button>
      )}
    </div>
  );
}
