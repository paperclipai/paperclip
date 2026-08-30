import { Issues } from "./Issues";

export function History() {
  return (
    <Issues
      statusFilter="done"
      excludePlanning
      title="History"
      viewStateKey="paperclip:delegate-history-view"
    />
  );
}
