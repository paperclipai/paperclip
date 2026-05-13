export function shellQuoteArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
