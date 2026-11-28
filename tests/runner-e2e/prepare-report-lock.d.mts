export function prepareReportLock(root?: string): Promise<'already-reviewed' | 'reviewed-correction'>;
export function refreshReportLock(root?: string, options?: { trustedLockSha256?: string }): Promise<'unchanged' | 'refreshed'>;
