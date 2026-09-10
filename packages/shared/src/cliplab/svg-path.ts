// Vendored from ClipLab a050f724; see PROVENANCE.md and LICENSE.
/** Compact projected vector paths. Curves are flattened below a display pixel,
 * then simplified after projection; strokes become filled outlines before warping. */
export type Point = { x: number; y: number }
export type PathCommand = { op: string; points: number[] }
export type Contour = { points: Point[]; closed: boolean }
export type ProjectPoint = (point: Point) => Point
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
function lineDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return distance(p, { x: a.x + dx * t, y: a.y + dy * t })
}
export function simplify(points: Point[], tolerance = .06): Point[] {
  if (points.length <= 2) return points
  let max = tolerance, index = -1
  for (let i = 1; i < points.length - 1; i++) { const d = lineDistance(points[i]!, points[0]!, points.at(-1)!); if (d > max) { max = d; index = i } }
  return index < 0 ? [points[0]!, points.at(-1)!] : [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)]
}
export function flatten(commands: PathCommand[], tolerance = .08): Contour[] {
  const contours: Contour[] = []
  let current: Contour | undefined
  const append = (p: Point) => { if (!current) { current = { points: [], closed: false }; contours.push(current) } current.points.push(p) }
  function cubic(a: Point, b: Point, c: Point, d: Point, depth = 0) {
    if (depth >= 12 || Math.max(lineDistance(b, a, d), lineDistance(c, a, d)) <= tolerance) { append(d); return }
    const ab = middle(a, b), bc = middle(b, c), cd = middle(c, d), abc = middle(ab, bc), bcd = middle(bc, cd), mid = middle(abc, bcd)
    cubic(a, ab, abc, mid, depth + 1); cubic(mid, bcd, cd, d, depth + 1)
  }
  for (const command of commands) {
    const p = command.points, end = { x: p.at(-2)!, y: p.at(-1)! }, start = current?.points.at(-1) ?? end
    if (command.op === 'M') { current = undefined; append(end) }
    else if (command.op === 'Z') { if (current) current.closed = true }
    else if (command.op === 'C') cubic(start, { x: p[0]!, y: p[1]! }, { x: p[2]!, y: p[3]! }, end)
    else if (command.op === 'Q') cubic(start, { x: start.x + (p[0]! - start.x) * 2 / 3, y: start.y + (p[1]! - start.y) * 2 / 3 }, { x: end.x + (p[0]! - end.x) * 2 / 3, y: end.y + (p[1]! - end.y) * 2 / 3 }, end)
    else append(end)
  }
  return contours
}
function arc(center: Point, start: number, delta: number, radius: number) {
  const count = Math.max(1, Math.ceil(Math.abs(delta) / .18))
  return Array.from({ length: count + 1 }, (_, i) => ({ x: center.x + Math.cos(start + delta * i / count) * radius, y: center.y + Math.sin(start + delta * i / count) * radius }))
}
/** Round joins/caps, matching all line artwork in the character renderer. */
export function strokeOutline(contour: Contour, width: number): Contour[] {
  let points = contour.points.filter((p, i, all) => !i || distance(p, all[i - 1]!) > 1e-7)
  if (points.length > 1 && distance(points[0]!, points.at(-1)!) < 1e-7) points = points.slice(0, -1)
  if (points.length < 2) return []
  const r = width / 2, len = points.length
  const direction = (a: Point, b: Point) => { const l = distance(a, b); return { x: (b.x - a.x) / l, y: (b.y - a.y) / l } }
  const side = (sign: number) => points.flatMap((p, i) => {
    const before = direction(points[(i - 1 + len) % len]!, p), after = direction(p, points[(i + 1) % len]!)
    if (!contour.closed && (!i || i === len - 1)) { const d = i ? before : after; return [{ x: p.x - d.y * r * sign, y: p.y + d.x * r * sign }] }
    const turn = Math.atan2(before.x * after.y - before.y * after.x, before.x * after.x + before.y * after.y)
    if (turn * sign < -.001) return arc(p, Math.atan2(before.x * sign, -before.y * sign), turn, r)
    const denom = Math.max(.05, 1 + before.x * after.x + before.y * after.y)
    return [{ x: p.x - (before.y + after.y) * r * sign / denom, y: p.y + (before.x + after.x) * r * sign / denom }]
  })
  const left = side(1), right = side(-1)
  if (contour.closed) return [{ points: left, closed: true }, { points: right.reverse(), closed: true }]
  const first = direction(points[0]!, points[1]!), last = direction(points[len - 2]!, points[len - 1]!)
  return [{ closed: true, points: [...left, ...arc(points.at(-1)!, Math.atan2(last.x, -last.y), -Math.PI, r), ...right.reverse(), ...arc(points[0]!, Math.atan2(-first.x, first.y), -Math.PI, r)] }]
}
export function pathData(contours: Contour[], project: ProjectPoint = p => p, tolerance = .06) {
  const n = (value: number) => String(Math.round(value * 1000) / 1000)
  return contours.map(contour => {
    // Subdivide straight art-space edges too: the face shell is curved.
    const points: Point[] = []
    const all = contour.closed ? [...contour.points, contour.points[0]!] : contour.points
    function segment(a: Point, b: Point, depth = 0) {
      const pa = project(a), pb = project(b), mid = middle(a, b), pm = project(mid)
      if (depth < 10 && (lineDistance(pm, pa, pb) > tolerance || distance(a, b) > 12)) { segment(a, mid, depth + 1); segment(mid, b, depth + 1) }
      else points.push(pb)
    }
    if (!all.length) return ''
    points.push(project(all[0]!)); for (let i = 1; i < all.length; i++) segment(all[i - 1]!, all[i]!)
    return simplify(points, tolerance).map((p, i) => `${i ? 'L' : 'M'}${n(p.x)} ${n(p.y)}`).join('') + (contour.closed ? 'Z' : '')
  }).join('')
}
/** Union a triangle/polygon tessellation by cancelling shared edges, keeping only
 * the boundary loops. The output has no interior mesh edges or per-triangle layers. */
export function boundaryContours(polygons: Point[][]): Contour[] {
  const key = (p: Point) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)}`
  const edges = new Map<string, { a: Point; b: Point; start: string; end: string }>()
  for (const poly of polygons) for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!, start = key(a), end = key(b)
    if (start === end) continue
    const reverse = `${end}/${start}`, forward = `${start}/${end}`
    if (edges.has(reverse)) edges.delete(reverse); else edges.set(forward, { a, b, start, end })
  }
  const starts = new Map<string, Set<string>>()
  for (const [id, e] of edges) { const set = starts.get(e.start) ?? new Set<string>(); set.add(id); starts.set(e.start, set) }
  const contours: Contour[] = []
  while (edges.size) {
    const first = edges.values().next().value!, points = [first.a]
    let next: string | undefined = `${first.start}/${first.end}`
    while (next) {
      const e = edges.get(next); if (!e) break
      edges.delete(next); starts.get(e.start)!.delete(next); points.push(e.b)
      if (e.end === first.start) break
      next = starts.get(e.end)?.values().next().value
    }
    if (points.length > 2) contours.push({ points, closed: true })
  }
  return contours
}
