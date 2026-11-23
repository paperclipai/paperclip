/** A disk record is not proof that this connection received the session context. */
export async function admitAcpxSessionContext(
  admission: { assertReady(): void },
  input: { providerSpawned: boolean; load: () => Promise<void>; refreshCommand: () => Promise<void> },
): Promise<void> {
  if (!input.providerSpawned) {
    await input.load();
    admission.assertReady();
    // ACPX control calls close their temporary connection. Its consumed native
    // command lease cannot be reused for the subsequent prompt connection.
    await input.refreshCommand();
  } else admission.assertReady();
}
