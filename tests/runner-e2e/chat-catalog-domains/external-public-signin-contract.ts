export interface PublicSignInInput {
  receiptPath: string;
  executionId: string;
  attemptId: string;
  backendOrigin: string;
  publicOrigin: string;
  userId: string;
  email: string;
  password: string;
}
export interface PublicSignInStorage {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}
export function validPublicSignInInput(value: PublicSignInInput) {
  try {
    const origin = new URL(value.publicOrigin),
      backend = new URL(value.backendOrigin);
    return (
      value.publicOrigin === origin.origin &&
      origin.protocol === "https:" &&
      !origin.username &&
      !origin.password &&
      value.backendOrigin === backend.origin &&
      backend.hostname === "127.0.0.1" &&
      backend.protocol === "http:" &&
      value.receiptPath.startsWith("/") &&
      !/[\r\n\0]/.test(value.receiptPath) &&
      [value.executionId, value.attemptId, value.userId].every(
        (id) => typeof id === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(id),
      ) &&
      /^mcp-[a-f0-9-]{36}@example\.test$/.test(value.email) &&
      typeof value.password === "string" &&
      value.password.length >= 16 &&
      value.password.length <= 8192
    );
  } catch {
    return false;
  }
}
export function publicSignInStorageMatches(
  value: unknown,
  publicOrigin: string,
): value is PublicSignInStorage {
  const storage = value as PublicSignInStorage | undefined;
  try {
    const origin = new URL(publicOrigin);
    return (
      !!storage &&
      Array.isArray(storage.cookies) &&
      storage.cookies.length > 0 &&
      storage.cookies.length <= 30 &&
      storage.cookies.every(
        (cookie) =>
          cookie.domain === origin.hostname &&
          cookie.secure === true &&
          cookie.path === "/" &&
          typeof cookie.name === "string" &&
          typeof cookie.value === "string" &&
          !!cookie.value,
      ) &&
      Array.isArray(storage.origins) &&
      storage.origins.length <= 1 &&
      storage.origins.every(
        (entry) =>
          entry.origin === publicOrigin &&
          Array.isArray(entry.localStorage) &&
          entry.localStorage.length <= 200 &&
          entry.localStorage.every(
            (item) =>
              typeof item.name === "string" && typeof item.value === "string",
          ),
      )
    );
  } catch {
    return false;
  }
}
