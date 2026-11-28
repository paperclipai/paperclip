import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { healthApi } from "@/api/health";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/select";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";

const updateGuide = "https://docs.paperclip.ing/how-to/update-paperclip/";
const updateMethods = [
  {
    id: "managed",
    label: "Managed CLI",
    instruction: "Run on the Paperclip host. On Windows with WSL 2, run it inside the same Linux distribution as Paperclip.",
    command: "paperclipai update --latest",
  },
  {
    id: "npm",
    label: "Global npm install",
    instruction: "Update the global package on the Paperclip host, then restart Paperclip from the same shell.",
    command: "npm install --global paperclipai@latest",
  },
  {
    id: "npx",
    label: "npx",
    instruction: "Stop the running instance, then start it again with the latest package.",
    command: "npx paperclipai@latest run",
  },
  {
    id: "container",
    label: "Docker or container deployment",
    instruction: "Update the Paperclip image tag and digest if pinned, then redeploy it through the system that manages the container.",
    documentation: "https://docs.paperclip.ing/reference/deploy/docker/",
  },
  {
    id: "source",
    label: "Source checkout",
    instruction: "Update the checkout to the target release, then install its dependencies and follow the update guide before restarting.",
    documentation: updateGuide,
  },
];

const stableVersionPattern = /^\d{4}\.\d{1,4}\.\d+$/;
const serverVersionPattern = /^(\d{4}\.\d{1,4}\.\d+)(-[\w.-]+)?(?:\+[\w.-]+)?$/;

type ReleaseStatus = "Up to date" | "Update available" | "Ahead of stable" | "Comparison unavailable";

function compareWithStable(runningVersion: string | undefined, stableVersion: string): ReleaseStatus {
  const running = runningVersion?.match(serverVersionPattern);
  if (!running) return "Comparison unavailable";

  const runningParts = running[1].split(".").map(Number);
  const stableParts = stableVersion.split(".").map(Number);
  for (const [index, part] of runningParts.entries()) {
    if (part < stableParts[index]) return "Update available";
    if (part > stableParts[index]) return "Ahead of stable";
  }
  return running[2] ? "Update available" : "Up to date";
}

async function fetchLatestStable(): Promise<string> {
  const response = await fetch("https://registry.npmjs.org/paperclipai/latest", {
    cache: "no-cache",
    credentials: "omit",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Paperclip release lookup failed");

  const data: { version?: unknown } = await response.json();
  if (typeof data.version !== "string" || !stableVersionPattern.test(data.version)) {
    throw new Error("Paperclip registry returned an invalid stable version");
  }
  return data.version;
}

export function PaperclipVersionSection() {
  const health = useQuery({ queryKey: queryKeys.health, queryFn: healthApi.get });
  const runningVersion = health.data?.version;
  const latest = useMutation({ mutationFn: fetchLatestStable });
  const stableVersion = latest.data;
  const status = stableVersion ? compareWithStable(runningVersion, stableVersion) : undefined;

  return (
    <Card role="region" aria-labelledby="paperclip-version-heading" className="max-w-2xl gap-3 py-4">
      <CardContent className="flex flex-wrap items-center justify-between gap-4 px-4">
        <div className="space-y-2">
          <h2 id="paperclip-version-heading" className="text-sm font-semibold">Paperclip version</h2>
          <dl className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <dt className="text-muted-foreground">Running version</dt>
            <dd className="font-mono font-medium">{runningVersion ?? (health.isPending ? "Loading…" : "Unavailable")}</dd>
          </dl>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button type="button" size="sm" disabled={latest.isPending} onClick={() => latest.mutate()}>
            <RefreshCw aria-hidden="true" />
            {latest.isPending ? "Checking…" : "Check for updates"}
          </Button>
          <div role="status">
            {latest.isError ? (
              <span className="text-sm text-destructive">Couldn’t check for updates. Try again.</span>
            ) : status ? (
              <Badge variant="secondary">{status}</Badge>
            ) : null}
          </div>
          {status === "Update available" && <PaperclipUpdateDialog targetVersion={stableVersion} />}
        </div>
      </CardContent>
    </Card>
  );
}

function PaperclipUpdateDialog({ targetVersion }: { targetVersion: string | undefined }) {
  const [method, setMethod] = useState(updateMethods[0]);
  const copy = useMutation({ mutationFn: copyTextToClipboard });
  const { command } = method;

  return (
    <Dialog onOpenChange={(open) => { if (open) copy.reset(); }}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">Update</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Paperclip</DialogTitle>
          <DialogDescription>
            {targetVersion && `Latest stable release: ${targetVersion}. `}Choose how Paperclip is installed on the host.
          </DialogDescription>
        </DialogHeader>
        <label className="grid gap-1.5 text-sm font-medium">
          Installation method
          <NativeSelect
            value={method.id}
            onChange={(event) => {
              const selected = updateMethods.find((option) => option.id === event.target.value);
              if (selected) setMethod(selected);
              copy.reset();
            }}
          >
            {updateMethods.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </NativeSelect>
        </label>
        <p className="text-sm text-muted-foreground">{method.instruction}</p>
        {command && (
          <code className="select-all rounded-md bg-muted p-3 font-mono text-sm">{command}</code>
        )}
        {copy.isError && <p role="status" className="text-sm text-destructive">Couldn’t copy. Select the command to copy it manually.</p>}
        <DialogFooter>
          {command ? (
            <Button type="button" disabled={copy.isPending} onClick={() => copy.mutate(command)}>
              {copy.isSuccess ? "Copied" : "Copy command"}
            </Button>
          ) : (
            <Button asChild>
              <a href={method.documentation} target="_blank" rel="noreferrer">Open update guide</a>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
