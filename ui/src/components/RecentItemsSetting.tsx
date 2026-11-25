import { useId } from "react";
import { RECENT_ITEMS_LIMIT_OPTIONS } from "@paperclipai/shared";
import { useRecentItemsLimit } from "@/hooks/useRecentItemsLimit";
import { NativeSelect } from "./ui/select";
import { Label } from "./ui/label";
import { Button } from "./ui/button";

export function RecentItemsSetting({ companyId, userId }: { companyId: string | null; userId: string | null }) {
  const preference = useRecentItemsLimit(userId);
  const id = useId();
  const error = preference.error instanceof Error ? preference.error.message : preference.error ? "Could not load your Recents preference." : null;
  return <section className="max-w-2xl space-y-4" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`} className="text-base font-semibold">Sidebar</h2>
    <div className="space-y-2">
      <Label htmlFor={id}>Recent items</Label>
      <p id={`${id}-description`} className="text-sm text-muted-foreground">Choose how many tasks, chats, and projects appear in Recents. Choose 0 to hide Recents and stop its task preloads. This setting applies to your account across companies and browsers. Pinned items stay available.</p>
      <NativeSelect id={id} aria-describedby={`${id}-description`} value={preference.loaded ? preference.limit : ""}
        disabled={!companyId || !preference.loaded || preference.isSaving}
        onChange={event => { if (companyId) void preference.setLimit(companyId, Number(event.target.value)).catch(() => {}); }}>
        {!preference.loaded && <option value="">Loading...</option>}
        {RECENT_ITEMS_LIMIT_OPTIONS.map(limit => <option key={limit} value={limit}>{limit === 0 ? "0 (Off)" : limit}</option>)}
      </NativeSelect>
      {preference.isSaving && <p role="status" className="text-sm text-muted-foreground">Saving...</p>}
      {!companyId && <p className="text-sm text-muted-foreground">Select a company to change this preference.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {error && !preference.loaded && <Button variant="outline" onClick={() => void preference.retry()}>Retry</Button>}
    </div>
  </section>;
}
