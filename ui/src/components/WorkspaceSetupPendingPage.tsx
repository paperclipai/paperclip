import { Card } from "@/components/ui/card";

export function WorkspaceSetupPendingPage() {
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">Your workspace is being set up</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          An owner or admin of this workspace hasn&apos;t finished creating the company yet.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          This page refreshes automatically — you&apos;ll land in the workspace as soon as it&apos;s
          ready.
        </p>
      </Card>
    </div>
  );
}
