const CAP_SECONDS = 3600;

export function backoffSeconds(attempts: number): number {
  if (attempts < 0 || !Number.isFinite(attempts)) return 30;
  const exp = Math.min(attempts, 30);
  return Math.min(2 ** exp * 30, CAP_SECONDS);
}
