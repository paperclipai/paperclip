export function hasCodeBuddyPermissionsBypassArg(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "-y" ||
      arg === "--dangerously-skip-permissions" ||
      arg === "--permission-mode" ||
      arg.startsWith("--permission-mode="),
  );
}
