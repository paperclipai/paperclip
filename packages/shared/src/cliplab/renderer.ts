// Vendored from ClipLab a050f724; see PROVENANCE.md and LICENSE.
import * as THREE from 'three'
import { BASE_POSE, detailAt, type Character, type Detail, type FaceLayer, type Pose, type Sample, type Shape } from './model.js'
import { clampGaze, gazeAtPoint, irisOffset, localGaze, type EyeGazes, type Gaze, type PointerLook } from './gaze.js'
import { drawMorphBrow, drawMorphEye, drawMorphMouth, drawDrool, droolAnchor, mouthGeometry, traitWeight } from './face-morph.js'

export interface RenderOptions {
  width: number; height: number; displaySize?: number; background?: string | null
  cursor?: { x: number; y: number }; rotation?: { x: number; y: number; z: number }; zoom?: number; framing?: 'portrait' | 'character'; pixelRatio?: number
  pointerLook?: PointerLook; eyeGazes?: EyeGazes; reducedMotion?: boolean
}
/** Cursor pitch owns the vertical look direction, independent of the resting tilt. */
export function characterRotation(character: Pick<Character, 'trueFront' | 'followRotation'>, pose: Pick<Pose, 'rotationX' | 'rotationY' | 'rotationZ'>, rotation = { x: -5, y: -12, z: -7 }, cursor: Gaze = { x: 0, y: 0 }) {
  if (character.trueFront) return { x: 0, y: 0, z: 0 }
  return {
    x: character.followRotation ? -cursor.y * 16 : rotation.x + pose.rotationX,
    y: rotation.y + pose.rotationY + (character.followRotation ? cursor.x * 28 : 0),
    z: rotation.z + pose.rotationZ
  }
}
/** One rounded light region; the body-following toggle activates
 * a subtle light-source shift. The shared eased cursor keeps motion smooth. */
export function toonLightOffset(character: Pick<Character, 'followRotation'>, cursor: Gaze = { x: 0, y: 0 }, reducedMotion = false): Gaze {
  const look = !reducedMotion && character.followRotation ? clampGaze(cursor) : { x: 0, y: 0 }
  return { x: -.015 + look.x * .045, y: .015 + look.y * .045 }
}
/** Size adaptation is render-only; larger sizes restore the authored appearance. */
export function faceForSize(character: Character, sample: Sample, size: number) {
  const simpleEyes = size > 16 && size <= 48
  const frontOnly = size <= 24
  const flatFill = size < 48
  return {
    character: simpleEyes || flatFill ? { ...character, ...(simpleEyes ? { iris: false } : {}), ...(flatFill ? { toon: false, shadow: false } : {}), ...(frontOnly ? { trueFront: true, lockPosition: true, followRotation: false } : {}) } : character,
    sample: simpleEyes || frontOnly ? { ...sample, pose: { ...sample.pose, faceScale: sample.pose.faceScale * (simpleEyes ? 1.3 : 1), eyeSize: sample.pose.eyeSize * (size === 24 ? 1.2 : 1), ...(frontOnly ? { squash: 1 } : {}), ...(size === 24 ? { gazeX: -4, gazeY: 0, leftX: 0, rightX: 0, leftY: 0, rightY: 0, spacing: BASE_POSE.spacing * .7, faceY: BASE_POSE.faceY } : {}) } } : sample,
    simpleEyes
  }
}
export const bodyHeight = (shape: Shape) => shape === 'capsule' ? 2 : 1
export function radiusAt(shape: Shape, y: number): number {
  if (shape === 'sphere') return Math.sqrt(Math.max(0, .25 - y * y))
  if (shape === 'capsule') { const dy = Math.max(Math.abs(y) - .5, 0); return Math.sqrt(Math.max(0, .25 - dy * dy)) }
  if (y >= 0) return Math.sqrt(Math.max(0, .25 - y * y))
  if (y >= -.43) return .5
  return .43 + Math.sqrt(Math.max(0, .07 ** 2 - (y + .43) ** 2))
}
function geometryFor(shape: Shape, squareBottom = false): THREE.BufferGeometry {
  if (shape === 'sphere') return new THREE.SphereGeometry(.5, 80, 64)
  if (shape === 'capsule') return new THREE.CapsuleGeometry(.5, 1, 24, 80)
  const points = [new THREE.Vector2(0, -.5), new THREE.Vector2(squareBottom ? .5 : .43, -.5)]
  for (let i = 1; !squareBottom && i <= 12; i++) { const a = -Math.PI / 2 + i / 12 * Math.PI / 2; points.push(new THREE.Vector2(.43 + .07 * Math.cos(a), -.43 + .07 * Math.sin(a))) }
  points.push(new THREE.Vector2(.5, 0))
  for (let i = 1; i <= 32; i++) { const a = i / 32 * Math.PI / 2; points.push(new THREE.Vector2(.5 * Math.cos(a), .5 * Math.sin(a))) }
  return new THREE.LatheGeometry(points, 80)
}
const vertexShader = `
  uniform vec3 fillScale;
  uniform vec3 fillOffset;
  varying vec3 vPosition;
  void main() {
    vPosition = position * fillScale + fillOffset;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const fragmentShader = `
  uniform vec3 colorA;
  uniform vec3 colorB;
  uniform float gradientOn;
  uniform float toonOn;
  uniform float insetFill;
  uniform float angle;
  uniform float bodyHeight;
  varying vec3 vPosition;
  void main() {
    float t = clamp(0.5 + vPosition.y / bodyHeight * cos(angle) + vPosition.x * sin(angle), 0.0, 1.0);
    vec3 color = mix(colorA, mix(colorB, colorA, t), gradientOn);
    // The light fill uses an inset copy of the silhouette, with one crisp shade step.
    float shade = mix(0.8, 1.0, insetFill);
    gl_FragColor = vec4(color * mix(1.0, shade, toonOn), 1.0);
    #include <colorspace_fragment>
  }
`
function heart(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x, y + r)
  ctx.bezierCurveTo(x - r * 2, y - r * .1, x - r, y - r * 1.5, x, y - r * .55)
  ctx.bezierCurveTo(x + r, y - r * 1.5, x + r * 2, y - r * .1, x, y + r); ctx.closePath(); ctx.fill()
}
function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, points = 5) {
  ctx.beginPath()
  for (let i = 0; i < points * 2; i++) { const a = i / (points * 2) * Math.PI * 2 - Math.PI / 2; const d = i % 2 ? r * .46 : r; const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py) }
  ctx.closePath(); ctx.fill()
}

const faceAspect = .76 / .57
const smoothstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const fract = (v: number) => ((v % 1) + 1) % 1
export function effectEnvelope(phase: number) { const t = fract(phase); return smoothstep(0, .18, t) * (1 - smoothstep(.72, 1, t)) }
export function eyeRadius(pose: Pose, character: Character, detail: Detail, side: number) { return (detail === 'eyes' ? 29 : 27) * pose.eyeSize * (side < 0 ? pose.leftScale : pose.rightScale) * (character.iris ? 1.2 : 1) }

export function projectedEye(character: Character, pose: Pose, blink: number, side: number, matrix: THREE.Matrix4, camera: THREE.Camera, layers?: FaceLayer[]) {
  const radius = eyeRadius(pose, character, 'full', side)
  const cx = 256 + side * 103 * pose.spacing + (side < 0 ? pose.leftX : pose.rightX)
  const cy = 197 - (side < 0 ? pose.leftY : pose.rightY)
  const angle = (pose.eyeTilt * side + (side < 0 ? pose.leftRotation : pose.rightRotation)) * Math.PI / 180
  const h = Math.max(.12, 1 - blink) * pose.eyeHeight * (1 - .35 * (layers ? traitWeight(layers, t => t.eye === 'soft') : pose.eye === 'soft' ? 1 : 0))
  const shell = character.elevated ? 1 + character.elevation : 1.003
  const project = (dx: number, dy: number) => {
    const tx = cx + Math.cos(angle) * dx - Math.sin(angle) * dy * h
    const ty = cy + faceAspect * (Math.sin(angle) * dx + Math.cos(angle) * dy * h)
    const x = (tx / 512 - .5) * .76 * pose.faceScale
    const y = (.5 - ty / 512) * .57 * pose.faceScale + (character.shape === 'capsule' ? -.14 : -.025) + pose.faceY
    const r = shell * radiusAt(character.shape, y / shell)
    return new THREE.Vector3(x, y, Math.sqrt(Math.max(.001, r * r - x * x))).applyMatrix4(matrix).project(camera)
  }
  const center = project(0, 0)
  // Central differences follow the tangent of the curved face at this eye.
  const right = project(radius * .1, 0).sub(project(-radius * .1, 0)).multiplyScalar(5).add(center)
  const up = project(0, -radius * .1).sub(project(0, radius * .1)).multiplyScalar(5).add(center)
  return { center, right, up }
}

/** Resting highlights are local to the face, so they remain up-left when tilted. */
function irisRestGaze(character: Pick<Character, 'iris' | 'followCursor'>, gaze: Gaze, reducedMotion = false): Gaze {
  if (!character.iris) return gaze
  if (reducedMotion) return { x: -.22, y: .22 }
  return character.followCursor ? gaze : { x: gaze.x - .22, y: gaze.y + .22 }
}

export function resolveEyeGazes(character: Character, pose: Pose, blink: number, matrix: THREE.Matrix4, camera: THREE.Camera, gaze: Gaze, pointer?: PointerLook, layers?: FaceLayer[]): EyeGazes {
  const eye = (side: number) => {
    const base = localGaze({ x: pose.gazeX + gaze.x, y: pose.gazeY + gaze.y }, pose.eyeTilt * side + (side < 0 ? pose.leftRotation : pose.rightRotation))
    if (!pointer?.weight) return base
    const { center, right, up } = projectedEye(character, pose, blink, side, matrix, camera, layers)
    const look = gazeAtPoint(pointer, center, right, up), weight = Math.max(0, Math.min(1, pointer.weight))
    return { x: base.x + (look.x - base.x) * weight, y: base.y + (look.y - base.y) * weight }
  }
  return { left: eye(-1), right: eye(1) }
}
function drop(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x, y - r * 1.5); ctx.bezierCurveTo(x - r * .25, y - r * .8, x - r, y - r * .2, x - r, y + r * .35); ctx.bezierCurveTo(x - r, y + r * 1.65, x + r, y + r * 1.65, x + r, y + r * .35); ctx.bezierCurveTo(x + r, y - r * .2, x + r * .25, y - r * .8, x, y - r * 1.5); ctx.fill()
}
export function drawFace(ctx: CanvasRenderingContext2D, pose: Pose, character: Character, blink: number, detail: Detail, gaze: { x: number; y: number }, effects: { phase?: number; tearAmount?: number; eyeGazes?: EyeGazes; faceLayers?: FaceLayer[]; simpleEyes?: boolean } = {}) {
  ctx.clearRect(0, 0, 512, 512)
  if (detail === 'body') return
  const ink = character.eyeColor, eyeY = detail === 'eyes' ? 254 : 197, spacing = 103 * pose.spacing
  const internalGaze = character.iris && detail === 'full'
  const gx = internalGaze ? 0 : (pose.gazeX + gaze.x) * 20, gy = internalGaze ? 0 : -(pose.gazeY + gaze.y) * 15
  const layers = effects.faceLayers
  const pupilAmount = !effects.simpleEyes && detail === 'full' ? layers ? traitWeight(layers, t => t.eye === 'pupil') : pose.eye === 'pupil' ? 1 : 0 : 0
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  for (const side of [-1, 1]) {
    const r = eyeRadius(pose, character, detail, side)
    const eyeGaze = side < 0 ? effects.eyeGazes?.left : effects.eyeGazes?.right
    const pupilEyes = !effects.simpleEyes && pose.eye === 'pupil' && detail === 'full'
    const x = 256 + side * spacing + gx * (1 - pupilAmount) + (side < 0 ? pose.leftX : pose.rightX), y = eyeY + gy * (1 - pupilAmount) - (side < 0 ? pose.leftY : pose.rightY)
    if (detail === 'full' && pose.blush > 0) {
      ctx.save(); ctx.globalAlpha = pose.blush * .8; ctx.fillStyle = '#ff647a'; ctx.beginPath(); ctx.ellipse(x + side * 20, y + 56, 31, 24 * faceAspect, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore()
    }
    const localRotation = side < 0 ? pose.leftRotation : pose.rightRotation
    // Equal world units in X/Y: the face mesh is wider than it is tall.
    ctx.save(); ctx.translate(x, y); ctx.scale(1, faceAspect); ctx.rotate((pose.eyeTilt * side + localRotation) * Math.PI / 180)
    ctx.fillStyle = ink; ctx.strokeStyle = ink; ctx.lineWidth = Math.max(13, r * .43)
    const happyMouth = ['open', 'grin', 'smile', 'u-smile'].includes(pose.mouth)
    const closed = ['closed', 'arc-up', 'arc-down'].includes(pose.eye) || (pose.eye === 'wink' && side > 0) || (detail === 'eyes' && ['open', 'grin'].includes(pose.mouth) && pose.eye === 'dot')
    if (effects.simpleEyes) {
      // Keep literal round dots even at eyes-only sizes or between styled beats.
      ctx.fillStyle = '#000000'; ctx.scale(1, Math.max(.12, 1 - blink))
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill()
    } else if (layers) {
      const look = eyeGaze ?? localGaze({ x: pose.gazeX + gaze.x, y: pose.gazeY + gaze.y }, pose.eyeTilt * side + localRotation)
      drawMorphEye(ctx, pose, layers, r, side, blink, detail, ink, character.iris, look)
    } else if (pose.faceSet === 'set-2' && pose.eye === 'wink' && side > 0) {
      ctx.beginPath(); ctx.moveTo(r * .7, -r * .65); ctx.lineTo(-r * .55, 0); ctx.lineTo(r * .7, r * .65); ctx.stroke()
    } else if (closed) {
      const up = pose.eye === 'arc-up' || (pose.eye !== 'arc-down' && happyMouth)
      ctx.beginPath(); ctx.arc(0, 0, r, up ? Math.PI : 0, up ? Math.PI * 2 : Math.PI); ctx.stroke()
    } else if (pose.eye === 'squint') {
      ctx.beginPath(); ctx.moveTo(-r * side * .7, -r * .8); ctx.lineTo(r * side * .6, 0); ctx.lineTo(-r * side * .7, r * .8); ctx.stroke()
    } else if (blink > .7) {
      ctx.beginPath(); ctx.moveTo(-r, 0); ctx.lineTo(r, 0); ctx.stroke()
    } else {
      const h = Math.max(.12, 1 - blink) * pose.eyeHeight * (pose.eye === 'soft' ? .65 : 1)
      ctx.scale(1, h)
      if (pose.cheeks) {
        // The cheek is transparent, revealing the live shaded body beneath the eye.
        ctx.beginPath(); ctx.rect(-r * 2, -r * 2, r * 4, r * 4); ctx.moveTo(r * .82, r * 1.13); ctx.arc(0, r * 1.13, r * .82, 0, Math.PI * 2); ctx.clip('evenodd')
      }
      if (pose.eye === 'star') star(ctx, 0, 0, r * 1.2)
      else if (pose.eye === 'heart') { if (pose.faceSet === 'set-2' && detail === 'full') ctx.fillStyle = '#ff3f58'; heart(ctx, 0, 0, r) }
      else if (pose.eye === 'half-lidded') { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI); ctx.closePath(); ctx.fill() }
      else if (pupilEyes) {
        const outer = r * 1.5
        ctx.fillStyle = '#fffef9'; ctx.beginPath(); ctx.arc(0, 0, outer, 0, Math.PI * 2); ctx.fill(); ctx.clip()
        const look = eyeGaze ?? { x: pose.gazeX + gaze.x, y: pose.gazeY + gaze.y }
        ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(look.x * outer * .52, -look.y * outer * .52, outer * .4, 0, Math.PI * 2); ctx.fill()
      }
      else { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill() }
      if (internalGaze && !pupilEyes && pose.eye !== 'half-lidded') {
        // The eye path also clips star/heart shapes and intersects cheek cutouts.
        ctx.clip()
        const dot = irisOffset(r, eyeGaze ?? { x: pose.gazeX + gaze.x, y: pose.gazeY + gaze.y }, eyeGaze ? 0 : pose.eyeTilt * side + localRotation, pose.cheeks)
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(dot.x, dot.y, r * .28, 0, Math.PI * 2); ctx.fill()
      }
    }
    ctx.restore()
    if (detail === 'full' && layers) {
      ctx.save(); ctx.translate(x, y - r * (1.45 + .35 * pupilAmount)); ctx.scale(1, faceAspect)
      drawMorphBrow(ctx, layers, r, side, ink); ctx.restore()
    } else if (detail === 'full' && pose.brows !== 'none') {
      ctx.save(); ctx.translate(x, y - (pupilEyes ? r * 1.8 : r * 1.45)); ctx.scale(1, faceAspect); ctx.strokeStyle = ink; ctx.lineWidth = 12; ctx.beginPath()
      if (pose.brows === 'raised') { ctx.arc(0, 10, r * .85, Math.PI * 1.15, Math.PI * 1.85) }
      else if (pose.brows === 'worried') { ctx.moveTo(side * r, 2); ctx.quadraticCurveTo(-side * r * .1, 10, -side * r * .75, -16) }
      else { ctx.moveTo(side * r, -10); ctx.lineTo(-side * r * .75, 8) }
      ctx.stroke(); ctx.restore()
    }
    if (pose.tears && detail === 'full') {
      const phase = fract((effects.phase ?? .35) + (side < 0 ? .46 : 0)), alpha = effectEnvelope(phase) * (effects.tearAmount ?? 1)
      ctx.save(); ctx.translate(x + side * (r + 18), y + 23 + phase * phase * 123); ctx.scale(1, faceAspect); ctx.rotate(-side * .2); ctx.globalAlpha = alpha; ctx.fillStyle = '#f6fdff'; drop(ctx, 0, 0, 12 + phase * 3); ctx.restore()
    }
  }
  if (detail === 'eyes') return
  if (layers) {
    ctx.save(); ctx.translate(256 + gx * .25, 293 + gy * .25); ctx.scale(1, faceAspect)
    drawMorphMouth(ctx, pose, layers, ink); ctx.restore(); return
  }
  const x = 256 + gx * .25, y = (pose.mouth === 'cry' ? 329 : 293) + gy * .25
  const broad = ['open', 'grin', 'cry'].includes(pose.mouth), w = (broad ? 124 : pose.mouth === 'oh' ? 51 : 61) * pose.mouthWidth
  const line = 17 * pose.mouthStroke
  ctx.save(); ctx.translate(x, y); ctx.scale(1, faceAspect); ctx.fillStyle = ink; ctx.strokeStyle = ink; ctx.lineWidth = line; ctx.beginPath()
  if (pose.mouth === 'smile') { ctx.arc(0, -10, w, Math.PI * .18, Math.PI * .82); ctx.stroke() }
  else if (pose.mouth === 'u-smile') { ctx.arc(0, -8, w * .56, 0, Math.PI); ctx.stroke() }
  else if (pose.mouth === 'frown') { ctx.arc(0, 39, w, Math.PI * 1.2, Math.PI * 1.8); ctx.stroke() }
  else if (pose.mouth === 'line' || pose.mouth === 'sleep') { ctx.moveTo(-w * .58, 0); ctx.lineTo(w * .58, 0); ctx.stroke() }
  else if (pose.mouth === 'kiss') { ctx.moveTo(-w * .25, -21); ctx.bezierCurveTo(w * .48, -34, w * .53, -2, 0, 0); ctx.bezierCurveTo(w * .53, 2, w * .48, 34, -w * .25, 21); ctx.stroke() }
  else if (pose.mouth === 'tongue-out') {
    ctx.beginPath(); ctx.moveTo(-w, -9); ctx.quadraticCurveTo(0, -2, w, -9); ctx.stroke()
    ctx.fillStyle = '#ff526c'; ctx.beginPath(); ctx.moveTo(-w * .6, 5); ctx.lineTo(w * .6, 5); ctx.bezierCurveTo(w * .88, 85 * pose.mouthOpen + 28, -w * .88, 85 * pose.mouthOpen + 28, -w * .6, 5); ctx.fill()
  }
  else if (pose.mouth === 'wave') { ctx.moveTo(-w, 4); ctx.bezierCurveTo(-w * .35, -25, w * .35, 25, w, -4); ctx.stroke() }
  else {
    const h = (broad ? 48 : 22) + 72 * pose.mouthOpen
    if (pose.mouth === 'oh') ctx.arc(0, 14, w * (.55 + .3 * pose.mouthOpen), 0, Math.PI * 2)
    else if (pose.mouth === 'cry') { ctx.moveTo(-w, 30); ctx.bezierCurveTo(-w * 1.1, -h, w * 1.1, -h, w, 30); ctx.quadraticCurveTo(w, 44, w * .76, 38); ctx.quadraticCurveTo(0, 24, -w * .76, 38); ctx.quadraticCurveTo(-w, 44, -w, 30) }
    else { const tilt = pose.mouth === 'grin' ? 24 : 0; ctx.moveTo(-w, -11); ctx.quadraticCurveTo(0, 5, w, -11 - tilt); ctx.bezierCurveTo(w * 1.02, h, -w * 1.02, h, -w, -11) }
    ctx.closePath(); ctx.fill(); ctx.save(); ctx.clip()
    if (pose.tongue) { ctx.fillStyle = '#f37b83'; ctx.beginPath(); ctx.ellipse(10, h * .65, w * .65, h * .34, -.1, 0, Math.PI * 2); ctx.fill() }
    if (pose.teeth) { ctx.fillStyle = '#fffef8'; ctx.beginPath(); ctx.roundRect(-w * .76, -23, w * 1.52, 30, 12); ctx.fill() }
    ctx.restore()
    // Rebuild the outer path after the clipped interior details changed the canvas path.
    ctx.beginPath()
    if (pose.mouth === 'oh') ctx.arc(0, 14, w * (.55 + .3 * pose.mouthOpen), 0, Math.PI * 2)
    else if (pose.mouth === 'cry') { ctx.moveTo(-w, 30); ctx.bezierCurveTo(-w * 1.1, -h, w * 1.1, -h, w, 30); ctx.quadraticCurveTo(w, 44, w * .76, 38); ctx.quadraticCurveTo(0, 24, -w * .76, 38); ctx.quadraticCurveTo(-w, 44, -w, 30) }
    else { const tilt = pose.mouth === 'grin' ? 24 : 0; ctx.moveTo(-w, -11); ctx.quadraticCurveTo(0, 5, w, -11 - tilt); ctx.bezierCurveTo(w * 1.02, h, -w * 1.02, h, -w, -11) }
    ctx.closePath(); ctx.strokeStyle = ink; ctx.stroke()
  }
  if (pose.drool) {
    const anchor = droolAnchor(mouthGeometry(pose).outline, w)
    if (pose.mouth === 'cry') anchor.y -= 27
    drawDrool(ctx, anchor)
  }
  ctx.restore()
}

export function drawProp(ctx: CanvasRenderingContext2D, prop: Pose['prop'], color: string, phase?: number) {
  ctx.clearRect(0, 0, 256, 256)
  const count = ['zzz', 'sparkle', 'heart'].includes(prop) ? 3 : 1
  for (let i = 0; i < count; i++) {
    const p = fract((phase ?? .34) + i * .29), ease = p * p
    ctx.save(); ctx.globalAlpha = phase === undefined ? 1 : effectEnvelope(p)
    ctx.translate(prop === 'zzz' ? 45 + i * 64 + ease * 36 : count === 1 ? 128 : 51 + i * 69, prop === 'zzz' ? 204 - i * 58 - ease * 54 : count === 1 ? 132 - ease * 26 : 198 - i * 60 - ease * 38)
    const scale = phase === undefined ? 1 : .62 + .38 * smoothstep(0, .38, p)
    ctx.scale(scale, scale); ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = 11; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    if (prop === 'zzz') { const r = 14 + i * 5; ctx.beginPath(); ctx.moveTo(-r, -r); ctx.lineTo(r, -r); ctx.lineTo(-r, r); ctx.lineTo(r, r); ctx.stroke() }
    else if (prop === 'sparkle') star(ctx, 0, 0, 23 + i * 4, 4)
    else if (prop === 'heart') heart(ctx, 0, 0, 17 + i * 3)
    else if (prop === 'question') { ctx.font = 'bold 144px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('?', 0, 48) }
    else if (prop === 'sweat') drop(ctx, 0, 0, 38)
    else if (prop === 'crown') { ctx.beginPath(); ctx.moveTo(-78, 42); ctx.lineTo(-94, -45); ctx.lineTo(-35, -3); ctx.lineTo(0, -67); ctx.lineTo(35, -3); ctx.lineTo(94, -45); ctx.lineTo(78, 42); ctx.closePath(); ctx.fill() }
    ctx.restore()
  }
}

export class CharacterRenderer {
  readonly canvas: HTMLCanvasElement | null
  readonly gl: THREE.WebGLRenderer | null
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 30)
  private root = new THREE.Group()
  private body: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  private lightFill: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  private face: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private faceCanvas: HTMLCanvasElement | null = null
  private faceCtx: CanvasRenderingContext2D | null = null
  private faceTexture: THREE.CanvasTexture | null = null
  private propCanvas: HTMLCanvasElement | null = null
  private propCtx: CanvasRenderingContext2D | null = null
  private propTexture: THREE.CanvasTexture | null = null
  private prop: THREE.Sprite
  private shadow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>
  private shape: Shape = 'capsule'
  private squareBottom = false
  private lastFaceKey = ''
  private resolvedEyes: EyeGazes | undefined
  private lastProp = ''
  private disposed = false
  private options: RenderOptions
  private captured?: { character: Character; sample: Sample; gaze: Gaze; simpleEyes: boolean }
  constructor(canvas: HTMLCanvasElement | null, options: RenderOptions) {
    this.canvas = canvas; this.options = options
    this.gl = null
    if (canvas) {
      this.faceCanvas = document.createElement('canvas')
      this.propCanvas = document.createElement('canvas')
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' })
    this.gl.outputColorSpace = THREE.SRGBColorSpace
    this.gl.setPixelRatio(options.pixelRatio ?? Math.min(Math.max(window.devicePixelRatio || 1, 1) * 2, 4))
    this.faceCanvas.width = this.faceCanvas.height = 1024
    this.faceCtx = this.faceCanvas.getContext('2d')!
    this.faceCtx.scale(2, 2)
    this.faceTexture = new THREE.CanvasTexture(this.faceCanvas); this.faceTexture.colorSpace = THREE.SRGBColorSpace
    this.faceTexture.generateMipmaps = true; this.faceTexture.minFilter = THREE.LinearMipmapLinearFilter
    this.propCanvas.width = this.propCanvas.height = 512; this.propCtx = this.propCanvas.getContext('2d')!; this.propCtx.scale(2, 2)
    this.propTexture = new THREE.CanvasTexture(this.propCanvas); this.propTexture.colorSpace = THREE.SRGBColorSpace
    }
    const material = new THREE.ShaderMaterial({
      uniforms: { colorA: { value: new THREE.Color() }, colorB: { value: new THREE.Color() }, gradientOn: { value: 1 }, toonOn: { value: 1 }, insetFill: { value: 0 }, fillScale: { value: new THREE.Vector3(1, 1, 1) }, fillOffset: { value: new THREE.Vector3() }, angle: { value: 0 }, bodyHeight: { value: 2 } }, vertexShader, fragmentShader
    })
    this.body = new THREE.Mesh(geometryFor('capsule'), material)
    const fillMaterial = material.clone(); fillMaterial.depthTest = false; fillMaterial.depthWrite = false; fillMaterial.uniforms.insetFill!.value = 1
    this.lightFill = new THREE.Mesh(new THREE.CapsuleGeometry(.42, .94, 24, 80), fillMaterial); this.lightFill.renderOrder = 1
    this.face = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 56, 40), new THREE.MeshBasicMaterial({ map: this.faceTexture, transparent: true, alphaTest: .008, depthWrite: false, side: THREE.FrontSide, toneMapped: false }))
    this.face.geometry.setAttribute('faceValid', new THREE.BufferAttribute(new Float32Array(this.face.geometry.attributes.position!.count).fill(1), 1))
    this.face.material.onBeforeCompile = shader => {
      shader.vertexShader = 'attribute float faceValid; varying float vFaceValid;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFaceValid = faceValid;')
      shader.fragmentShader = 'varying float vFaceValid;\n' + shader.fragmentShader.replace('void main() {', 'void main() {\nif (vFaceValid < 0.99) discard;')
    }
    this.prop = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.propTexture, transparent: true, depthWrite: false, toneMapped: false }))
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(.35, 64), new THREE.MeshBasicMaterial({ color: '#809299', transparent: true, opacity: .2, depthWrite: false }))
    this.root.add(this.body, this.lightFill, this.face, this.prop); this.scene.add(this.root, this.shadow)
    this.camera.position.set(0, 0, 8); this.camera.lookAt(0, 0, 0)
    this.resize(options.width, options.height, options.displaySize)
  }
  resize(width: number, height: number, displaySize?: number) {
    this.options = { ...this.options, width: Math.max(1, width), height: Math.max(1, height), displaySize: displaySize ?? Math.min(width, height) }
    this.gl?.setSize(this.options.width, this.options.height, false)
  }
  render(character: Character, sample: Sample, options: Partial<RenderOptions> = {}, gaze = { x: 0, y: 0 }) {
    if (this.disposed) return
    this.options = { ...this.options, ...options }
    const displaySize = this.options.displaySize ?? Math.min(this.options.width, this.options.height)
    const appearance = faceForSize(character, sample, displaySize)
    character = appearance.character; sample = appearance.sample
    const squareBottom = character.shape === 'cap' && displaySize <= 24
    if (character.shape !== this.shape || squareBottom !== this.squareBottom) { this.shape = character.shape; this.squareBottom = squareBottom; this.body.geometry.dispose(); this.body.geometry = geometryFor(this.shape, squareBottom); this.lightFill.geometry.dispose(); this.lightFill.geometry = this.shape === 'capsule' ? new THREE.CapsuleGeometry(.42, .94, 24, 80) : geometryFor(this.shape) }
    const { pose } = sample
    const height = bodyHeight(this.shape)
    const detail = detailAt(displaySize)
    const u = this.body.material.uniforms
    ;(u.colorA!.value as THREE.Color).set(character.color); (u.colorB!.value as THREE.Color).set(character.color2)
    u.gradientOn!.value = character.gradient ? 1 : (sample.gradientMix ?? (sample.gradientRotation !== undefined ? 1 : 0)); u.toonOn!.value = character.toon ? 1 : 0
    u.angle!.value = (character.gradientAngle + (sample.gradientRotation ?? 0)) * Math.PI / 180; u.bodyHeight!.value = height
    const rotation = characterRotation(this.options.reducedMotion ? { ...character, followRotation: false } : character, pose, this.options.rotation, this.options.cursor)
    this.root.rotation.set(rotation.x * Math.PI / 180, rotation.y * Math.PI / 180, rotation.z * Math.PI / 180, 'YXZ')
    this.root.position.y = character.lockPosition ? 0 : sample.bob * .025 * height
    const stretch = pose.squash + (character.lockPosition ? 0 : sample.breathe * .008)
    this.root.scale.set(1 / Math.sqrt(stretch), stretch, 1 / Math.sqrt(stretch))
    this.lightFill.visible = character.toon
    const fillScale = this.shape === 'capsule' ? 1 : .85
    this.lightFill.scale.setScalar(fillScale)
    this.root.updateMatrixWorld(true)
    // Shift the inset toward the pointer in the camera plane, not the tilted
    // body's axes. Bound travel by the narrowest stretch to retain a dark rim.
    const lightTarget = toonLightOffset(character, this.options.cursor, this.options.reducedMotion)
    const lightScale = Math.min(this.root.scale.x, this.root.scale.y, this.root.scale.z)
    const lightOffset = new THREE.Vector3(lightTarget.x * lightScale, lightTarget.y * lightScale, 0).applyMatrix4(new THREE.Matrix4().copy(this.root.matrixWorld).invert())
      .sub(new THREE.Vector3().applyMatrix4(new THREE.Matrix4().copy(this.root.matrixWorld).invert()))
    this.lightFill.position.copy(lightOffset)
    const fu = this.lightFill.material.uniforms
    for (const name of ['colorA', 'colorB']) (fu[name]!.value as THREE.Color).copy(u[name]!.value as THREE.Color)
    for (const name of ['gradientOn', 'toonOn', 'angle', 'bodyHeight']) fu[name]!.value = u[name]!.value
    ;(fu.fillScale!.value as THREE.Vector3).setScalar(fillScale); (fu.fillOffset!.value as THREE.Vector3).copy(lightOffset)
    const zoom = displaySize <= 128 ? 1 : this.options.zoom ?? 1
    const aspect = this.options.width / this.options.height
    // Small assets use a tight body fit instead of the companion preview padding.
    const padding = this.options.framing === 'character' ? .82 : displaySize <= 128 ? .55 : .72
    let half = Math.max(height * padding, padding / aspect) / zoom
    if (displaySize === 48 || displaySize === 96) {
      // A sphere bounds every rotation, avoiding angle-dependent zoom changes.
      if (!this.body.geometry.boundingSphere) this.body.geometry.computeBoundingSphere()
      const sphere = this.body.geometry.boundingSphere!
      const radius = (sphere.radius + sphere.center.length()) * Math.max(1, this.root.scale.x, this.root.scale.y, this.root.scale.z)
      const safeHalf = (radius + this.root.position.length()) / .9
      half = Math.max(half, safeHalf, safeHalf / aspect)
    }
    this.camera.left = -half * aspect; this.camera.right = half * aspect; this.camera.top = half; this.camera.bottom = -half; this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld(true)
    this.face.visible = detail !== 'body'
    // Pointer directions stay relative to the screen when the character rolls or turns.
    const reduced = !!this.options.reducedMotion
    const screenGaze = reduced ? { x: 0, y: 0 } : gaze
    const turnGaze = !reduced && !character.followCursor && character.followRotation && !character.trueFront ? this.options.cursor ?? { x: 0, y: 0 } : { x: 0, y: 0 }
    const local = character.iris ? new THREE.Vector3(screenGaze.x + turnGaze.x * .5, screenGaze.y + turnGaze.y * .5, 0).applyQuaternion(this.root.quaternion.clone().invert()) : screenGaze
    const faceGaze = displaySize === 24 ? { x: 0, y: 0 } : irisRestGaze(character, local, reduced)
    this.resolvedEyes = !appearance.simpleEyes && detail === 'full' && (character.iris || pose.eye === 'pupil' || sample.faceLayers?.some(l => l.traits.eye === 'pupil')) ? (!reduced ? this.options.eyeGazes : undefined) ?? resolveEyeGazes(character, reduced ? { ...pose, gazeX: 0, gazeY: 0 } : pose, sample.blink, this.root.matrixWorld, this.camera, faceGaze, !reduced && character.followCursor ? this.options.pointerLook : undefined, sample.faceLayers) : undefined
    const key = JSON.stringify([pose, sample.faceLayers, character.eyeColor, character.iris, appearance.simpleEyes, sample.blink.toFixed(3), pose.tears ? sample.effectPhase?.toFixed(2) : 0, sample.tearAmount, detail, faceGaze.x.toFixed(3), faceGaze.y.toFixed(3), this.resolvedEyes])
    if (this.faceCtx && this.faceTexture && key !== this.lastFaceKey) { drawFace(this.faceCtx, pose, character, sample.blink, detail, faceGaze, { phase: sample.effectPhase, tearAmount: sample.tearAmount, eyeGazes: this.resolvedEyes, faceLayers: sample.faceLayers, simpleEyes: appearance.simpleEyes }); this.faceTexture.needsUpdate = true; this.lastFaceKey = key }
    const vertices = this.face.geometry.attributes.position!
    const uv = this.face.geometry.attributes.uv!
    const valid = this.face.geometry.attributes.faceValid!
    const shell = character.elevated ? 1 + character.elevation : 1.003
    const scale = pose.faceScale
    const offset = (this.shape === 'capsule' ? -.14 : -.025) + pose.faceY
    for (let i = 0; i < vertices.count; i++) {
      const x = (uv.getX(i) - .5) * .76 * scale
      const y = (uv.getY(i) - .5) * .57 * scale + offset
      const r = shell * radiusAt(this.shape, y / shell)
      const z = Math.sqrt(Math.max(.001, r * r - x * x))
      vertices.setXYZ(i, x, y, z)
      valid.setX(i, x * x < r * r && Math.abs(y) < height / 2 * shell ? 1 : 0)
    }
    vertices.needsUpdate = true; valid.needsUpdate = true; this.face.geometry.computeBoundingSphere()
    this.prop.visible = detail === 'full' && pose.prop !== 'none'
    this.prop.material.depthTest = pose.prop !== 'zzz'
    this.prop.renderOrder = pose.prop === 'zzz' ? 2 : 0
    const propKey = `${pose.prop}:${sample.effectPhase?.toFixed(2) ?? 'still'}`
    if (this.propCtx && this.propTexture && propKey !== this.lastProp) { drawProp(this.propCtx, pose.prop, pose.prop === 'heart' ? '#ff768c' : pose.prop === 'sweat' ? '#b7e9ff' : '#ffd362', sample.effectPhase); this.propTexture.needsUpdate = true; this.lastProp = propKey }
    const propSize = this.shape === 'capsule' ? .42 : .32
    this.prop.scale.setScalar(propSize * (.7 + .3 * (sample.propAmount ?? 1))); this.prop.material.opacity = sample.propAmount ?? 1
    this.prop.position.set(pose.prop === 'crown' ? 0 : .56, pose.prop === 'crown' ? height / 2 + .08 : height * .29, .15)
    this.shadow.visible = character.shadow && detail === 'full'
    this.shadow.position.set(0, -height * .58, -.2)
    this.shadow.scale.set((1 - (character.lockPosition ? 0 : sample.bob) * .06) * (this.shape === 'capsule' ? 1 : .95), .12, 1)
    const bg = this.options.background
    if (bg) this.gl?.setClearColor(bg, 1); else this.gl?.setClearColor(0x000000, 0)
    this.scene.updateMatrixWorld(true)
    this.gl?.render(this.scene, this.camera)
    this.captured = { character, sample, gaze: faceGaze, simpleEyes: appearance.simpleEyes }
  }
  snapshotScene() {
    if (!this.captured) throw new Error('Render the character before taking a snapshot.')
    return { ...this.captured, options: this.options, camera: this.camera, body: this.body, lightFill: this.lightFill, face: this.face, prop: this.prop, shadow: this.shadow, eyeGazes: this.resolvedEyes }
  }
  orientation() { return this.root.quaternion.clone() }
  eyeGazes() { return this.resolvedEyes ? { left: { ...this.resolvedEyes.left }, right: { ...this.resolvedEyes.right } } : undefined }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.body.geometry.dispose(); this.body.material.dispose(); this.lightFill.geometry.dispose(); this.lightFill.material.dispose(); this.face.geometry.dispose(); this.face.material.dispose()
    this.faceTexture?.dispose(); this.propTexture?.dispose(); this.prop.material.dispose(); this.shadow.geometry.dispose(); this.shadow.material.dispose()
    this.gl?.dispose(); this.gl?.forceContextLoss()
  }
}

let thumbRenderer: CharacterRenderer | undefined
const thumbs = new Map<string, string>()
export function thumbnail(character: Character, pose: Pose = BASE_POSE, size = 96): string {
  const key = JSON.stringify([character, pose, size])
  const cached = thumbs.get(key); if (cached) return cached
  try {
    if (!thumbRenderer) thumbRenderer = new CharacterRenderer(document.createElement('canvas'), { width: 192, height: 192, pixelRatio: 1, displaySize: size })
    thumbRenderer.render({ ...character, shadow: false }, { pose, blink: 0, bob: 0, breathe: 0, expressionId: '', beatIndex: 0, stepIndex: 0 }, { displaySize: size, rotation: { x: -3, y: -8, z: -5 }, zoom: 1.08 })
    const url = thumbRenderer.canvas!.toDataURL('image/png'); if (thumbs.size > 250) thumbs.clear(); thumbs.set(key, url); return url
  } catch { return '' }
}
