/** These two independently authenticated search probes consume a successful
 * JSON body once. json() owns that stream reader; cancel() afterward throws
 * on its locked stream. An unread denied body still needs cancellation. */
export async function readSearchProbeResponse(response: Response): Promise<{ status: number; body: unknown }> {
  if (response.ok) return { status: response.status, body: await response.json() };
  await response.body?.cancel();
  return { status: response.status, body: null };
}
