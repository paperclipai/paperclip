/** A local callback result is not evidence that the provider received its reply. */
export function requireAcpxResponseDelivery(context: { responseDelivery?: Promise<void> }): Promise<void> {
  if (!context.responseDelivery || typeof context.responseDelivery.then !== "function") {
    throw new Error("ACP interaction has no bound provider response delivery receipt");
  }
  return context.responseDelivery;
}

/** Settle the callback first: the SDK can only write after that callback returns. */
export async function deliverAcpxResponse(
  responseDelivery: Promise<void>,
  settle: () => void,
): Promise<{ resolved: true }> {
  settle();
  await responseDelivery;
  return { resolved: true };
}
