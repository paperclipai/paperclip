import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';

export function SkillSourceSyncControls({ automaticUpdates, refreshing, disabled, onRefresh, onAutomaticUpdates, showPreference = true }: {
  automaticUpdates: boolean;
  showPreference?: boolean;
  refreshing?: boolean;
  disabled?: boolean;
  onRefresh: () => void;
  onAutomaticUpdates: (enabled: boolean) => void;
}) {
  return <div className="flex flex-wrap items-center gap-3">
    {showPreference && <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <ToggleSwitch checked={automaticUpdates} disabled={disabled} onCheckedChange={onAutomaticUpdates} aria-label="Automatic updates" />
      Automatic updates
    </label>}
    <Button size="sm" variant="outline" disabled={disabled || refreshing} onClick={onRefresh}>
      <RefreshCw className={refreshing ? 'size-3.5 animate-spin motion-reduce:animate-none' : 'size-3.5'} />
      {refreshing ? 'Refreshing…' : 'Refresh'}
    </Button>
  </div>;
}
