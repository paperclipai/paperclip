export type VirtualOfficeRoutineLike = {
  title?: string | null;
  description?: string | null;
};

const VIRTUAL_OFFICE_ROUTINE_PATTERN = /Sandbox routine:|Virtual Office|安全邊界|Sandbox\/Test/i;

export function isVirtualOfficeRoutineLike(routine: VirtualOfficeRoutineLike | null | undefined) {
  if (!routine) return false;
  return VIRTUAL_OFFICE_ROUTINE_PATTERN.test(`${routine.title ?? ""} ${routine.description ?? ""}`);
}
