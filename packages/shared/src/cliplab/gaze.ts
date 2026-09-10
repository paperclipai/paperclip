// Vendored from ClipLab a050f724; see PROVENANCE.md and LICENSE.
export interface Gaze { x: number; y: number }
export interface PointerLook extends Gaze { weight: number }
export interface EyeGazes { left: Gaze; right: Gaze }
export const centeredGaze = (): Gaze => ({ x: 0, y: 0 })
export const inactivePointer = (): PointerLook => ({ x: 0, y: 0, weight: 0 })

/** Geometric canvas coordinates retain the target's position, even outside the canvas. */
export function pointerLook(pointer: { clientX: number; clientY: number }, bounds: { left: number; top: number; width: number; height: number }): PointerLook {
  return { x: (pointer.clientX - bounds.left) / Math.max(1, bounds.width) * 2 - 1, y: 1 - (pointer.clientY - bounds.top) / Math.max(1, bounds.height) * 2, weight: 1 }
}

export function easePointer(current: PointerLook, target: PointerLook, seconds: number, immediate = false): PointerLook {
  return { ...easeGaze(current, target, seconds, immediate), weight: easeGaze({ x: current.weight, y: 0 }, { x: target.weight, y: 0 }, seconds, immediate).x }
}

/** Solve in the projected eye's own axes, then gently saturate travel with distance. */
export function gazeAtPoint(pointer: Gaze, center: Gaze, right: Gaze, up: Gaze): Gaze {
  const rx = right.x - center.x, ry = right.y - center.y, ux = up.x - center.x, uy = up.y - center.y
  const determinant = rx * uy - ry * ux
  if (Math.abs(determinant) < 1e-10) return centeredGaze()
  const dx = pointer.x - center.x, dy = pointer.y - center.y
  const x = (dx * uy - dy * ux) / determinant, y = (rx * dy - ry * dx) / determinant
  const distance = Math.hypot(x, y, 1.15)
  return { x: x / distance, y: y / distance }
}

export function localGaze(gaze: Gaze, rotation: number): Gaze {
  const angle = rotation * Math.PI / 180
  return clampGaze({ x: gaze.x * Math.cos(angle) - gaze.y * Math.sin(angle), y: gaze.x * Math.sin(angle) + gaze.y * Math.cos(angle) })
}

export function clampGaze({ x, y }: Gaze): Gaze {
  x = Number.isFinite(x) ? x : 0; y = Number.isFinite(y) ? y : 0
  const length = Math.max(1, Math.hypot(x, y))
  return { x: x / length, y: y / length }
}

export function pointerGaze(pointer: { clientX: number; clientY: number }, bounds: { left: number; top: number; width: number; height: number }): Gaze {
  return clampGaze({
    x: (pointer.clientX - bounds.left - bounds.width / 2) / Math.max(80, bounds.width / 2),
    y: -(pointer.clientY - bounds.top - bounds.height / 2) / Math.max(80, bounds.height / 2)
  })
}

/** Time-based easing, shared by the studio and paused or playing app characters. */
export function easeGaze(current: Gaze, target: Gaze, seconds: number, immediate = false): Gaze {
  const amount = immediate ? 1 : 1 - Math.exp(-Math.max(0, seconds) * 16)
  const next = { x: current.x + (target.x - current.x) * amount, y: current.y + (target.y - current.y) * amount }
  return Math.hypot(next.x - target.x, next.y - target.y) < .0005 ? { ...target } : next
}

/** Keep the complete white dot inside the eye, with a small margin at every angle. */
export function irisOffset(radius: number, gaze: Gaze, eyeRotation = 0, cheeks: boolean | number = false): Gaze {
  const look = clampGaze(gaze), angle = eyeRotation * Math.PI / 180
  const x = look.x * radius * .62, y = -look.y * radius * .62
  const dot = { x: x * Math.cos(angle) + y * Math.sin(angle), y: -x * Math.sin(angle) + y * Math.cos(angle) }
  // Stay above the cheek's circular cutout, including the dot radius and a small gap.
  if (cheeks) {
    const amount = typeof cheeks === 'number' ? Math.max(0, Math.min(1, cheeks)) : 1
    const clearance = radius * (.82 * Math.sqrt(amount) + .305)
    if (Math.abs(dot.x) < clearance) dot.y = Math.min(dot.y, radius * 1.13 - Math.sqrt(clearance ** 2 - dot.x ** 2))
  }
  return dot
}
