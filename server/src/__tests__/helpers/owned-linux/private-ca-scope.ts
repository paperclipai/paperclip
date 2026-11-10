// PRIVATE fixture-only isolated Node24.22.2 worker scope. No TLS bypass.
import { X509Certificate, createHash } from "node:crypto";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

export function beginOwnedPrivateCA(input: { pem: string; SHA256: string }): () => void {
  const certificate = new X509Certificate(input.pem);
  if (!certificate.ca || createHash("sha256").update(input.pem).digest("hex") !== input.SHA256) throw new Error("owned_ca_identity_mismatch");
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, input.pem]);
  let restored = false;
  return () => { if (!restored) { setDefaultCACertificates(previous); restored = true; } };
}

export async function withOwnedPrivateCA<T>(input: {
  pem: string;
  SHA256: string;
  run(): Promise<T>;
  closeOwnedResources(): Promise<void>;
}): Promise<T> {
  const restore = beginOwnedPrivateCA(input);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try { outcome = { ok: true, value: await input.run() }; }
  catch (error) { outcome = { ok: false, error }; }
  const errors: unknown[] = outcome.ok ? [] : [outcome.error];
  try { await input.closeOwnedResources(); }
  catch (error) { errors.push(error); }
  finally {
    // Restore even when the real resource join fails; retain BOTH failures.
    try { restore(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "owned_ca_scope_or_cleanup_failed");
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
