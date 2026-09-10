// Vendored from ClipLab a050f724; see PROVENANCE.md and LICENSE.
import { flatten, pathData, strokeOutline, type ProjectPoint } from './svg-path.js'
// A small vector recorder for the Canvas 2D operations used by ClipLab's faces.
// Paths stay editable; no bitmap or external asset is embedded in the SVG.
type Matrix = [number, number, number, number, number, number]
type Command = { op: string; points: number[] }
const identity = (): Matrix => [1, 0, 0, 1, 0, 0]
export const xml = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
export const number = (n: number) => String(Math.round(n * 100000) / 100000)
const point = (m: Matrix, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
const inverse = (m: Matrix): Matrix => {
  const d = m[0] * m[3] - m[1] * m[2]
  return d ? [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d] : identity()
}
export class SvgCanvas {
  fillStyle = '#000000'; strokeStyle = '#000000'; lineWidth = 1; globalAlpha = 1
  lineCap = 'butt'; lineJoin = 'miter'; font = '10px sans-serif'; textAlign = 'start'
  private matrix = identity()
  private clips: string[] = []
  private stack: ReturnType<SvgCanvas['state']>[] = []
  private path: Command[] = []
  private nodes: string[] = []
  private definitions: string[] = []
  bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
  constructor(private prefix: string, private project?: ProjectPoint) {}
  private state() { return { matrix: [...this.matrix] as Matrix, clips: [...this.clips], fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, globalAlpha: this.globalAlpha, lineCap: this.lineCap, lineJoin: this.lineJoin, font: this.font, textAlign: this.textAlign } }
  save() { this.stack.push(this.state()) }
  restore() { const state = this.stack.pop(); if (state) Object.assign(this, state) }
  clearRect() { this.nodes = []; this.definitions = []; this.path = []; this.bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity } }
  transform(a: number, b: number, c: number, d: number, e: number, f: number) {
    const m = this.matrix
    this.matrix = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]]
  }
  translate(x: number, y: number) { this.transform(1, 0, 0, 1, x, y) }
  scale(x: number, y: number) { this.transform(x, 0, 0, y, 0, 0) }
  rotate(a: number) { this.transform(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0) }
  beginPath() { this.path = [] }
  closePath() { this.path.push({ op: 'Z', points: [] }) }
  private command(op: string, coords: number[]) {
    const points = []
    for (let i = 0; i < coords.length; i += 2) points.push(...point(this.matrix, coords[i]!, coords[i + 1]!))
    this.path.push({ op, points })
  }
  moveTo(x: number, y: number) { this.command('M', [x, y]) }
  lineTo(x: number, y: number) { this.command(this.path.length ? 'L' : 'M', [x, y]) }
  bezierCurveTo(...coords: [number, number, number, number, number, number]) { this.command('C', coords) }
  quadraticCurveTo(...coords: [number, number, number, number]) { this.command('Q', coords) }
  rect(x: number, y: number, w: number, h: number) { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath() }
  roundRect(x: number, y: number, w: number, h: number, radius: number) {
    const r = Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2)
    this.moveTo(x + r, y); this.lineTo(x + w - r, y); this.arc(x + w - r, y + r, r, -Math.PI / 2, 0)
    this.lineTo(x + w, y + h - r); this.arc(x + w - r, y + h - r, r, 0, Math.PI / 2)
    this.lineTo(x + r, y + h); this.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI)
    this.lineTo(x, y + r); this.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5); this.closePath()
  }
  arc(x: number, y: number, radius: number, start: number, end: number, ccw = false) { this.ellipse(x, y, radius, radius, 0, start, end, ccw) }
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number, ccw = false) {
    const tau = Math.PI * 2
    let delta = end - start
    if (!ccw) delta = delta >= tau ? tau : ((delta % tau) + tau) % tau
    else delta = delta <= -tau ? -tau : -(((-delta % tau) + tau) % tau)
    const at = (a: number) => [x + rx * Math.cos(a) * Math.cos(rotation) - ry * Math.sin(a) * Math.sin(rotation), y + rx * Math.cos(a) * Math.sin(rotation) + ry * Math.sin(a) * Math.cos(rotation)]
    const tangent = (a: number) => [-rx * Math.sin(a) * Math.cos(rotation) - ry * Math.cos(a) * Math.sin(rotation), -rx * Math.sin(a) * Math.sin(rotation) + ry * Math.cos(a) * Math.cos(rotation)]
    const first = at(start); this.lineTo(first[0]!, first[1]!)
    const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)))
    for (let i = 0; i < segments; i++) {
      const a = start + delta * i / segments, b = start + delta * (i + 1) / segments, k = 4 / 3 * Math.tan((b - a) / 4)
      const p = at(a), q = at(b), u = tangent(a), v = tangent(b)
      this.bezierCurveTo(p[0]! + k * u[0]!, p[1]! + k * u[1]!, q[0]! - k * v[0]!, q[1]! - k * v[1]!, q[0]!, q[1]!)
    }
  }
  private data(matrix = identity()) {
    return this.path.map(c => {
      const coords = []
      for (let i = 0; i < c.points.length; i += 2) coords.push(...point(matrix, c.points[i]!, c.points[i + 1]!))
      return c.op + coords.map(number).join(' ')
    }).join(' ')
  }
  private add(node: string) { this.nodes.push(this.clips.reduceRight((value, id) => `<g clip-path="url(#${id})">${value}</g>`, node)) }
  private paint(stroke: boolean, rule = 'nonzero') {
    if (this.globalAlpha <= 0) return
    const expansion = stroke ? this.lineWidth * Math.max(Math.hypot(this.matrix[0], this.matrix[1]), Math.hypot(this.matrix[2], this.matrix[3])) / 2 : 0
    for (const c of this.path) for (let i = 0; i < c.points.length; i += 2) {
      this.bounds.left = Math.min(this.bounds.left, c.points[i]! - expansion); this.bounds.right = Math.max(this.bounds.right, c.points[i]! + expansion)
      this.bounds.top = Math.min(this.bounds.top, c.points[i + 1]! - expansion); this.bounds.bottom = Math.max(this.bounds.bottom, c.points[i + 1]! + expansion)
    }
    if (this.project) {
      const inv = inverse(this.matrix)
      const commands = this.path.map(c => ({ op: c.op, points: c.points.flatMap((_, i) => i % 2 ? [] : point(inv, c.points[i]!, c.points[i + 1]!)) }))
      const contours = flatten(commands)
      const outlines = stroke ? contours.flatMap(c => strokeOutline(c, this.lineWidth)) : contours.map(c => ({ ...c, closed: true }))
      const project: ProjectPoint = p => { const [x, y] = point(this.matrix, p.x, p.y); return this.project!({ x: x!, y: y! }) }
      this.add(`<path d="${pathData(outlines, project)}" opacity="${number(this.globalAlpha)}" fill="${xml(stroke ? this.strokeStyle : this.fillStyle)}" fill-rule="${rule}"/>`)
      return
    }
    this.add(`<path d="${this.data(inverse(this.matrix))}" transform="matrix(${this.matrix.map(number).join(' ')})" opacity="${number(this.globalAlpha)}" ${stroke ? `fill="none" stroke="${xml(this.strokeStyle)}" stroke-width="${number(this.lineWidth)}" stroke-linecap="${xml(this.lineCap)}" stroke-linejoin="${xml(this.lineJoin)}"` : `fill="${xml(this.fillStyle)}" fill-rule="${rule}"`}/>`)
  }
  fill(rule = 'nonzero') { this.paint(false, rule) }
  stroke() { this.paint(true) }
  clip(rule = 'nonzero') {
    const id = `${this.prefix}-clip-${this.definitions.length}`
    this.definitions.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${this.project ? pathData(flatten(this.path).map(c => ({ ...c, closed: true })), this.project) : this.data()}" clip-rule="${rule}"/></clipPath>`); this.clips.push(id)
  }
  fillText(text: string, x: number, y: number) {
    const size = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 10)
    this.add(`<text x="${number(x)}" y="${number(y)}" transform="matrix(${this.matrix.map(number).join(' ')})" font-family="sans-serif" font-size="${size}" font-weight="${this.font.includes('bold') ? 'bold' : 'normal'}" text-anchor="${this.textAlign === 'center' ? 'middle' : 'start'}" fill="${xml(this.fillStyle)}" opacity="${number(this.globalAlpha)}">${xml(text)}</text>`)
  }
  markup() { return `<defs>${this.definitions.join('')}</defs>${this.nodes.join('')}` }
}
