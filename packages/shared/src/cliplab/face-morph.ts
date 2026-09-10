// Vendored from ClipLab a050f724; see PROVENANCE.md and LICENSE.
import type { Detail, FaceLayer, Pose } from './model.js'
import { irisOffset, type Gaze } from './gaze.js'

export type Point = { x: number; y: number }
const COUNT = 128, TAU = Math.PI * 2
const pt = (x: number, y: number): Point => ({ x, y })
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y)
const unit = (a: Point) => { const n = Math.hypot(a.x, a.y) || 1; return pt(a.x / n, a.y / n) }
const arc = (x: number, y: number, rx: number, ry: number, from = 0, to = TAU, count = 64) => Array.from({ length: count + 1 }, (_, i) => { const a = from + (to - from) * i / count; return pt(x + Math.cos(a) * rx, y + Math.sin(a) * ry) })
const cubic = (a: Point, b: Point, c: Point, d: Point, n = 32) => Array.from({ length: n + 1 }, (_, i) => {
  const t = i / n, s = 1 - t
  return pt(s ** 3 * a.x + 3 * s ** 2 * t * b.x + 3 * s * t ** 2 * c.x + t ** 3 * d.x, s ** 3 * a.y + 3 * s ** 2 * t * b.y + 3 * s * t ** 2 * c.y + t ** 3 * d.y)
})
const quad = (a: Point, b: Point, c: Point) => cubic(a, pt(a.x + (b.x - a.x) * 2 / 3, a.y + (b.y - a.y) * 2 / 3), pt(c.x + (b.x - c.x) * 2 / 3, c.y + (b.y - c.y) * 2 / 3), c)
const area = (p: Point[]) => p.reduce((sum, a, i) => { const b = p[(i + 1) % p.length]!; return sum + a.x * b.y - b.x * a.y }, 0)
function clean(points: Point[]) {
  const p = points.filter((point, i) => i === 0 || distance(point, points[i - 1]!) > .00001)
  if (p.length > 1 && distance(p[0]!, p.at(-1)!) < .00001) p.pop()
  return p
}
/** Stable winding, anchor and perimeter correspondence; never align against a live blend. */
export function contour(points: Point[]): Point[] {
  let p = clean(points)
  if (p.length < 2) return Array.from({ length: COUNT }, () => ({ ...(p[0] ?? pt(0, 0)) }))
  if (area(p) < 0) p.reverse()
  let anchor = 0
  for (let i = 1; i < p.length; i++) if (p[i]!.x < p[anchor]!.x - .00001 || (Math.abs(p[i]!.x - p[anchor]!.x) < .00001 && p[i]!.y < p[anchor]!.y)) anchor = i
  p = [...p.slice(anchor), ...p.slice(0, anchor)]
  const lengths = p.map((a, i) => distance(a, p[(i + 1) % p.length]!)), total = lengths.reduce((a, b) => a + b, 0)
  let segment = 0, traversed = 0
  return Array.from({ length: COUNT }, (_, i) => {
    const target = total * i / COUNT
    while (segment < p.length - 1 && traversed + lengths[segment]! < target) traversed += lengths[segment++]!
    const a = p[segment]!, b = p[(segment + 1) % p.length]!, t = (target - traversed) / (lengths[segment] || 1)
    return pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
  })
}
function ribbon(points: Point[], width: number): Point[] {
  const p = clean(points), h = width / 2
  const normals = p.slice(1).map((b, i) => { const a = p[i]!; return unit(pt(a.y - b.y, b.x - a.x)) })
  if (!normals.length) return arc(p[0]!.x, p[0]!.y, h, h)
  const side = (sign: number) => p.flatMap((a, i) => {
    const before = normals[Math.max(0, i - 1)]!, after = normals[Math.min(normals.length - 1, i)]!
    const cross = before.x * after.y - before.y * after.x
    if (i > 0 && i < p.length - 1 && cross * sign < -.0001) {
      const from = Math.atan2(before.y * sign, before.x * sign)
      const delta = Math.atan2(cross, before.x * after.x + before.y * after.y)
      return arc(a.x, a.y, h, h, from, from + delta, Math.max(2, Math.ceil(Math.abs(delta) * 10)))
    }
    const n = unit(pt(before.x + after.x, before.y + after.y)), reach = h / Math.max(.35, n.x * after.x + n.y * after.y)
    return [pt(a.x + n.x * reach * sign, a.y + n.y * reach * sign)]
  })
  const end = p.at(-1)!, first = p[0]!, endAngle = Math.atan2(normals.at(-1)!.y, normals.at(-1)!.x), startAngle = Math.atan2(normals[0]!.y, normals[0]!.x)
  return [...side(1), ...arc(end.x, end.y, h, h, endAngle, endAngle - Math.PI, 16), ...side(-1).reverse(), ...arc(first.x, first.y, h, h, startAngle - Math.PI, startAngle - TAU, 16)]
}
function expand(points: Point[], amount: number) {
  const p = clean(points); if (area(p) < 0) p.reverse()
  return p.flatMap((a, i) => {
    const before = p[(i - 1 + p.length) % p.length]!, after = p[(i + 1) % p.length]!
    const u = unit(pt(a.y - before.y, before.x - a.x)), v = unit(pt(after.y - a.y, a.x - after.x)), n = unit(pt(u.x + v.x, u.y + v.y))
    const cross = u.x * v.y - u.y * v.x
    if (cross > .0001) {
      const from = Math.atan2(u.y, u.x), delta = Math.atan2(cross, u.x * v.x + u.y * v.y)
      return arc(a.x, a.y, amount, amount, from, from + delta, Math.max(2, Math.ceil(delta * 10)))
    }
    const reach = amount / Math.max(.5, n.x * v.x + n.y * v.y)
    return [pt(a.x + n.x * reach, a.y + n.y * reach)]
  })
}
export const traitWeight = (layers: FaceLayer[], predicate: (pose: FaceLayer['traits']) => boolean) => layers.reduce((n, layer) => n + (predicate(layer.traits) ? layer.weight : 0), 0)
export function blendContours(contours: Point[][], layers: FaceLayer[]): Point[] {
  return Array.from({ length: COUNT }, (_, i) => contours.reduce((point, shape, j) => pt(point.x + shape[i]!.x * layers[j]!.weight, point.y + shape[i]!.y * layers[j]!.weight), pt(0, 0)))
}
function trace(ctx: CanvasRenderingContext2D, shape: Point[]) {
  ctx.beginPath(); ctx.moveTo(shape[0]!.x, shape[0]!.y)
  for (const point of shape.slice(1)) ctx.lineTo(point.x, point.y)
  ctx.closePath()
}
export function isLineEye(pose: Pick<Pose, 'eye' | 'mouth'>, side: number, detail: Detail) {
  return ['closed', 'arc-up', 'arc-down', 'squint'].includes(pose.eye) || (pose.eye === 'wink' && side > 0) || (detail === 'eyes' && ['open', 'grin'].includes(pose.mouth) && pose.eye === 'dot')
}
export function eyeContour(pose: Pose, r: number, side: number, blink: number, detail: Detail): Point[] {
  const stroke = Math.max(13, r * .43)
  if ((pose.faceSet === 'set-2' && pose.eye === 'wink' && side > 0) || pose.eye === 'squint') {
    const sign = pose.eye === 'wink' ? -1 : side
    return contour(ribbon([pt(-r * sign * .7, -r * .8), pt(r * sign * .6, 0), pt(-r * sign * .7, r * .8)], stroke))
  }
  if (isLineEye(pose, side, detail)) {
    const happy = ['open', 'grin', 'smile', 'u-smile'].includes(pose.mouth)
    const up = pose.eye === 'arc-up' || (pose.eye !== 'arc-down' && happy)
    return contour(ribbon(arc(0, 0, r, r, up ? Math.PI : 0, up ? TAU : Math.PI), stroke))
  }
  const h = Math.max(.12, 1 - blink) * pose.eyeHeight * (pose.eye === 'soft' ? .65 : 1)
  let shape: Point[]
  if (pose.eye === 'star') shape = Array.from({ length: 10 }, (_, i) => { const a = i / 10 * TAU - Math.PI / 2, size = r * 1.2 * (i % 2 ? .46 : 1); return pt(Math.cos(a) * size, Math.sin(a) * size) })
  else if (pose.eye === 'heart') shape = [...cubic(pt(0, r), pt(-r * 2, -r * .1), pt(-r, -r * 1.5), pt(0, -r * .55)), ...cubic(pt(0, -r * .55), pt(r, -r * 1.5), pt(r * 2, -r * .1), pt(0, r))]
  else if (pose.eye === 'half-lidded') shape = arc(0, 0, r, r, 0, Math.PI)
  else { const size = r * (pose.eye === 'pupil' && detail === 'full' ? 1.5 : 1); shape = arc(0, 0, size, size) }
  const open = contour(shape.map(p => pt(p.x, p.y * h)))
  const closing = Math.max(0, Math.min(1, (blink - .5) / .5))
  if (!closing) return open
  const closed = contour(ribbon([pt(-r, 0), pt(r, 0)], stroke))
  return open.map((p, i) => pt(p.x + (closed[i]!.x - p.x) * closing, p.y + (closed[i]!.y - p.y) * closing))
}
export function mouthGeometry(pose: Pose): { outline: Point[]; opening: Point[]; width: number; height: number } {
  const broad = ['open', 'grin', 'cry'].includes(pose.mouth), w = (broad ? 124 : pose.mouth === 'oh' ? 51 : 61) * pose.mouthWidth
  const h = (broad ? 48 : 22) + 72 * pose.mouthOpen, stroke = 17 * pose.mouthStroke
  let path: Point[], filled = false
  if (pose.mouth === 'smile') path = arc(0, -10, w, w, Math.PI * .18, Math.PI * .82)
  else if (pose.mouth === 'u-smile') path = arc(0, -8, w * .56, w * .56, 0, Math.PI)
  else if (pose.mouth === 'frown') path = arc(0, 39, w, w, Math.PI * 1.2, Math.PI * 1.8)
  else if (pose.mouth === 'line' || pose.mouth === 'sleep') path = [pt(-w * .58, 0), pt(w * .58, 0)]
  else if (pose.mouth === 'kiss') path = [...cubic(pt(-w * .25, -21), pt(w * .48, -34), pt(w * .53, -2), pt(0, 0)), ...cubic(pt(0, 0), pt(w * .53, 2), pt(w * .48, 34), pt(-w * .25, 21))]
  else if (pose.mouth === 'wave') path = cubic(pt(-w, 4), pt(-w * .35, -25), pt(w * .35, 25), pt(w, -4))
  else if (pose.mouth === 'tongue-out') path = quad(pt(-w, -9), pt(0, -2), pt(w, -9))
  else {
    filled = true
    if (pose.mouth === 'oh') { const r = w * (.55 + .3 * pose.mouthOpen); path = arc(0, 14, r, r) }
    else if (pose.mouth === 'cry') path = [...cubic(pt(-w, 30), pt(-w * 1.1, -h), pt(w * 1.1, -h), pt(w, 30)), ...quad(pt(w, 30), pt(w, 44), pt(w * .76, 38)), ...quad(pt(w * .76, 38), pt(0, 24), pt(-w * .76, 38)), ...quad(pt(-w * .76, 38), pt(-w, 44), pt(-w, 30))].map(p => pt(p.x, p.y + 36 / (4 / 3)))
    else { const tilt = pose.mouth === 'grin' ? 24 : 0; path = [...quad(pt(-w, -11), pt(0, 5), pt(w, -11 - tilt)), ...cubic(pt(w, -11 - tilt), pt(w * 1.02, h), pt(-w * 1.02, h), pt(-w, -11))] }
  }
  return { outline: contour(filled ? expand(path, stroke / 2) : ribbon(path, stroke)), opening: filled ? contour(path) : Array.from({ length: COUNT }, () => pt(0, 0)), width: w, height: h }
}
function colorMix(colors: { color: string; weight: number }[]) {
  const value = [0, 0, 0]
  for (const { color, weight } of colors) for (let i = 0; i < 3; i++) value[i]! += parseInt(color.slice(1 + i * 2, 3 + i * 2), 16) * weight
  return `rgb(${value.map(v => Math.round(v)).join(',')})`
}
export function drawMorphEye(ctx: CanvasRenderingContext2D, pose: Pose, layers: FaceLayer[], r: number, side: number, blink: number, detail: Detail, ink: string, iris: boolean, gaze: Gaze) {
  const shape = blendContours(layers.map(layer => eyeContour({ ...pose, ...layer.traits }, r, side, blink, detail)), layers)
  const filled = (traits: FaceLayer['traits']) => !isLineEye(traits, side, detail)
  const cheeks = traitWeight(layers, t => t.cheeks && filled(t))
  ctx.save()
  if (cheeks > 0) {
    const h = Math.max(.12, 1 - blink) * pose.eyeHeight * (1 - .35 * traitWeight(layers, t => t.eye === 'soft')), cut = r * .82 * Math.sqrt(cheeks)
    ctx.beginPath(); ctx.rect(-r * 3, -r * 3, r * 6, r * 6); ctx.moveTo(cut, r * 1.13 * h); ctx.ellipse(0, r * 1.13 * h, cut, cut * h, 0, 0, TAU); ctx.clip('evenodd')
  }
  ctx.fillStyle = colorMix(layers.map(({ traits, weight }) => ({ weight, color: detail === 'full' && traits.eye === 'pupil' ? '#fffef9' : detail === 'full' && traits.eye === 'heart' && traits.faceSet === 'set-2' ? '#ff3f58' : ink })))
  trace(ctx, shape); ctx.fill(); ctx.clip()
  ctx.scale(1, Math.max(.12, 1 - blink) * pose.eyeHeight * (1 - .35 * traitWeight(layers, t => t.eye === 'soft')))
  const pupil = detail === 'full' ? traitWeight(layers, t => t.eye === 'pupil') : 0
  if (pupil > 0) {
    ctx.globalAlpha = pupil * (1 - blink); ctx.fillStyle = ink
    ctx.beginPath(); ctx.arc(gaze.x * r * 1.5 * .52, -gaze.y * r * 1.5 * .52, r * .6, 0, TAU); ctx.fill()
  }
  const visible = iris && detail === 'full' ? traitWeight(layers, t => filled(t) && t.eye !== 'pupil' && t.eye !== 'half-lidded') : 0
  if (visible > 0) {
    const dot = irisOffset(r, gaze, 0, cheeks)
    ctx.globalAlpha = visible * (1 - blink); ctx.fillStyle = '#ffffff'
    ctx.beginPath(); ctx.arc(dot.x, dot.y, r * .28, 0, TAU); ctx.fill()
  }
  ctx.restore()
}
/** Find the lower contour at the drool's right-side attachment point. Using
 * the rendered outline keeps it attached throughout mouth-shape morphs. */
export function droolAnchor(outline: Point[], width: number): Point {
  const x = Math.min(width * .35, Math.max(...outline.map(p => p.x)) * .75)
  let bottom = -Infinity
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!, b = outline[(i + 1) % outline.length]!
    if ((a.x <= x && b.x >= x) || (b.x <= x && a.x >= x)) {
      const y = Math.abs(b.x - a.x) < 1e-8 ? Math.max(a.y, b.y) : a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x)
      bottom = Math.max(bottom, y)
    }
  }
  // The round cap overlaps the lip by two units so there is no visible gap.
  return { x, y: (Number.isFinite(bottom) ? bottom : 0) + 6 }
}
export function drawDrool(ctx: CanvasRenderingContext2D, anchor: Point, amount = 1) {
  ctx.save(); ctx.globalAlpha = amount; ctx.strokeStyle = '#fffef5'; ctx.lineWidth = 16
  ctx.beginPath(); ctx.moveTo(anchor.x, anchor.y); ctx.lineTo(anchor.x + 3, anchor.y + 34 * amount); ctx.stroke()
  ctx.fillStyle = '#fffef5'; ctx.beginPath(); ctx.arc(anchor.x + 3, anchor.y + 38 * amount, 8 * amount, 0, TAU); ctx.fill(); ctx.restore()
}
export function drawMorphMouth(ctx: CanvasRenderingContext2D, pose: Pose, layers: FaceLayer[], ink: string) {
  const geometry = layers.map(layer => mouthGeometry({ ...pose, ...layer.traits }))
  const outline = blendContours(geometry.map(g => g.outline), layers), opening = blendContours(geometry.map(g => g.opening), layers)
  const w = geometry.reduce((sum, g, i) => sum + g.width * layers[i]!.weight, 0), h = geometry.reduce((sum, g, i) => sum + g.height * layers[i]!.weight, 0)
  ctx.fillStyle = ink; trace(ctx, outline); ctx.fill()
  ctx.save(); trace(ctx, outline); ctx.clip(); trace(ctx, opening); ctx.clip()
  const tongue = traitWeight(layers, t => t.tongue), teeth = traitWeight(layers, t => t.teeth)
  ctx.translate(0, 27 * traitWeight(layers, t => t.mouth === 'cry'))
  if (tongue > 0) { ctx.globalAlpha = tongue; ctx.fillStyle = '#f37b83'; ctx.beginPath(); ctx.ellipse(10, h * .65, w * .65, h * .34, -.1, 0, TAU); ctx.fill() }
  if (teeth > 0) { ctx.globalAlpha = teeth; ctx.fillStyle = '#fffef8'; ctx.beginPath(); ctx.roundRect(-w * .76, -23, w * 1.52, 30, 12); ctx.fill() }
  ctx.restore()
  const out = traitWeight(layers, t => t.mouth === 'tongue-out')
  if (out > 0) {
    const w = 61 * pose.mouthWidth
    ctx.save(); ctx.globalAlpha = out; ctx.fillStyle = '#ff526c'; ctx.beginPath(); ctx.moveTo(-w * .6 * out, 5); ctx.lineTo(w * .6 * out, 5); ctx.bezierCurveTo(w * .88 * out, (85 * pose.mouthOpen + 28) * out, -w * .88 * out, (85 * pose.mouthOpen + 28) * out, -w * .6 * out, 5); ctx.fill(); ctx.restore()
  }
  const drool = traitWeight(layers, t => t.drool)
  if (drool > 0) drawDrool(ctx, droolAnchor(outline, w), drool)
}

export function drawMorphBrow(ctx: CanvasRenderingContext2D, layers: FaceLayer[], r: number, side: number, ink: string) {
  if (!layers.some(layer => layer.traits.brows !== 'none')) return
  const shapes = layers.map(({ traits }) => {
    if (traits.brows === 'none') return contour([pt(0, 0)])
    const path = traits.brows === 'raised' ? arc(0, 10, r * .85, r * .85, Math.PI * 1.15, Math.PI * 1.85)
      : traits.brows === 'worried' ? quad(pt(side * r, 2), pt(-side * r * .1, 10), pt(-side * r * .75, -16))
        : [pt(side * r, -10), pt(-side * r * .75, 8)]
    return contour(ribbon(path, 12))
  })
  ctx.fillStyle = ink; trace(ctx, blendContours(shapes, layers)); ctx.fill()
}
