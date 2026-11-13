let runAdmissionClosed = false;

export function closeProcessRunAdmission(): void {
  runAdmissionClosed = true;
}

export function isProcessRunAdmissionClosed(): boolean {
  return runAdmissionClosed;
}

export function resetProcessRunAdmissionForTests(): void {
  runAdmissionClosed = false;
}
