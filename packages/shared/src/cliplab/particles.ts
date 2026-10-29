// Vendored from ClipLab 987b6db0 (v0.2.0); see PROVENANCE.md and LICENSE.
import type { Pose } from './model.js'

export type ParticleSettings = Pick<Pose, 'propSize' | 'propCount' | 'propOutward'>
export const defaultParticleCount = (prop: Pose['prop']) => ['zzz', 'sparkle', 'heart'].includes(prop) ? 3 : prop === 'none' ? 0 : 1
export const particleCount = (prop: Pose['prop'], count = 0) => prop === 'none' ? 0 : count > 0 ? Math.max(1, Math.min(6, Math.round(count))) : defaultParticleCount(prop)
export function particleLayout(prop: Pose['prop'], phase?: number, settings: Partial<ParticleSettings> = {}) {
  const count = particleCount(prop, settings.propCount)
  const size = settings.propSize ?? 1, outward = settings.propOutward ?? 1
  // A fixed padded canvas for the entire cycle prevents large/outward particles
  // clipping against the texture edge or changing size as the padding changes.
  const radius = prop === 'crown' ? 100 : prop === 'question' ? 105 : prop === 'sweat' ? 80 : 48
  const extent = Math.max(256, 2 * (110 + outward * 90 + radius * size))
  const particles = Array.from({ length: count }, (_, i) => {
    const index = count > 1 ? i * 2 / (count - 1) : 0
    const p = (((phase ?? .34) + i * .29) % 1 + 1) % 1
    const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t) }
    const ease = p * p
    const x = count === 1 ? 128 : (prop === 'zzz' ? 45 + index * 64 : 51 + index * 69)
    const y = count === 1 ? 132 : (prop === 'zzz' ? 204 - index * 58 : 198 - index * 60)
    return { index, x: x + ease * 36 * outward, y: y - ease * (count === 1 ? 26 : prop === 'zzz' ? 54 : 38) * outward,
      scale: size * (phase === undefined ? 1 : .62 + .38 * smooth(p / .38)),
      alpha: phase === undefined ? 1 : smooth(p / .18) * (1 - smooth((p - .68) / .32)) }
  })
  return { extent, particles }
}
