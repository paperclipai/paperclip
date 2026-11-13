export function redactNativeFailureError(error: Error, redact: (text: string) => string): Error {
  const originalMessage = error.message;
  const message = redact(originalMessage);
  const stack = error.stack
    ? redact(originalMessage ? error.stack.split(originalMessage).join(message) : error.stack)
    : undefined;
  try {
    error.message = message;
    if (stack !== undefined) error.stack = stack;
    return error;
  } catch {
    const replacement = new Error(message);
    replacement.name = error.name;
    replacement.stack = stack ?? `${error.name}: ${message}`;
    return replacement;
  }
}
