/** Test-only transport barrier: the card is committed, but its creation response
 * stays in flight until the browser answers. No provider instructions change. */
export async function holdInteractionResponse(input: {
  loadStatus(): Promise<string>;
  deadlineAt: number;
  now?: () => number;
  pause?: () => Promise<void>;
}) {
  const now = input.now ?? Date.now;
  const pause = input.pause ?? (() => new Promise<void>((r) => setTimeout(r, 50)));
  while (now() < input.deadlineAt) {
    const status = await input.loadStatus();
    if (status !== "pending") return status;
    await pause();
  }
  throw new Error("Approval overlap fixture timed out waiting for the browser response");
}
