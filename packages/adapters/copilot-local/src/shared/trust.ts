export function hasCursorTrustBypassArg(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--trust" ||
      arg === "--yolo" ||
      arg === "-f" ||
      arg.startsWith("--trust="),
  );
}
