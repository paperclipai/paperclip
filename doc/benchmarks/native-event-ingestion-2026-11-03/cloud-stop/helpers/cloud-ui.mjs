export function cloudStreamMarker(page, runId) {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('invalid_owned_run_id');
  return page.getByTestId('task-chat-thread')
    .getByTestId('task-chat-phase-interstitial')
    .getByText('CLOUD-STOP-STREAM: real sandbox process is starting.', { exact: true });
}
