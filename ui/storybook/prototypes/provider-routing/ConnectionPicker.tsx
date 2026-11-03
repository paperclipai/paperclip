import { useId } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isAdvancedProvider, type Connection } from "./model";

const connectAccount = "__connect_account__";

export function ConnectionPicker({
  selected,
  connections,
  disabled,
  onSelect,
  onConnect,
}: {
  selected: Connection;
  connections: Connection[];
  disabled?: boolean;
  onSelect: (id: string) => void;
  onConnect: () => void;
}) {
  const id = useId();
  const choices = [...connections].sort(
    (a, b) =>
      Number(b.id === selected.id) - Number(a.id === selected.id) ||
      Number(isAdvancedProvider(a.provider)) -
        Number(isAdvancedProvider(b.provider)),
  );
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Connection
      </label>
      <Select
        value={selected.id}
        disabled={disabled}
        onValueChange={(value) => {
          if (value === connectAccount) onConnect();
          else onSelect(value);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue>{selected.name}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {choices.map((connection) => (
            <SelectItem key={connection.id} value={connection.id}>
              {connection.name}
            </SelectItem>
          ))}
          {connections.length === 0 && (
            <SelectItem value="__none__" disabled>
              No compatible connections
            </SelectItem>
          )}
          <SelectSeparator />
          <SelectItem value={connectAccount}>Connect an account…</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
