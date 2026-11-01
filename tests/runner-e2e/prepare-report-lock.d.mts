export function prepareReportLock(root?: string): Promise<'already-reviewed' | 'reviewed-correction'>;
export function refreshReportLock(root?: string): Promise<'unchanged' | 'refreshed'>;
