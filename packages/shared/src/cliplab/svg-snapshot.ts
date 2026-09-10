// Vendored from ClipLab a050f724; see PROVENANCE.md and LICENSE.
import * as THREE from 'three'
import { drawFace, drawProp, type CharacterRenderer } from './renderer.js'
import { detailAt } from './model.js'
import { SvgCanvas, number as n, xml } from './svg-canvas.js'
import { boundaryContours, pathData, type Point, type ProjectPoint } from './svg-path.js'

type Snapshot = ReturnType<CharacterRenderer['snapshotScene']>
type Vertex = { x: number; y: number; z: number; t: number }
type Triangle = { points: Vertex[]; indices: number[] }
const cross = (a: Pick<Vertex, 'x' | 'y'>, b: Pick<Vertex, 'x' | 'y'>, c: Pick<Vertex, 'x' | 'y'>) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
function hull(points: Vertex[]) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const half = (items: Vertex[]) => { const out: Vertex[] = []; for (const p of items) { while (out.length > 1 && cross(out.at(-2)!, out.at(-1)!, p) <= 0) out.pop(); out.push(p) } return out }
  return [...half(sorted).slice(0, -1), ...half([...sorted].reverse()).slice(0, -1)]
}
function clip(points: Vertex[], threshold: number, above: boolean) {
  const out: Vertex[] = []
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!, insideA = above ? a.z >= threshold : a.z <= threshold, insideB = above ? b.z >= threshold : b.z <= threshold
    if (insideA) out.push(a)
    if (insideA !== insideB) {
      const f = (threshold - a.z) / (b.z - a.z)
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f, t: a.t + (b.t - a.t) * f })
    }
  }
  return out
}
/** Best-fit planar gradient, weighted by visible projected area. A curved 3D
 * surface is not exactly representable by one SVG linear gradient; this keeps
 * the authored colors and a compact, editable fill at every camera angle. */
export function fitGradient(triangles: { points: Vertex[] }[]) {
  let weight = 0, x = 0, y = 0, t = 0
  const samples: { p: Vertex; w: number }[] = []
  for (const { points } of triangles) {
    const w = Math.abs(cross(points[0]!, points[1]!, points[2]!)) / 6
    for (const p of points) { samples.push({ p, w }); weight += w; x += p.x * w; y += p.y * w; t += p.t * w }
  }
  if (!weight) return { x: 0, y: 0, t: .5, gx: 0, gy: 0 }
  x /= weight; y /= weight; t /= weight
  let xx = 0, xy = 0, yy = 0, xt = 0, yt = 0
  for (const { p, w } of samples) { const dx = p.x - x, dy = p.y - y, dt = p.t - t; xx += dx * dx * w; xy += dx * dy * w; yy += dy * dy * w; xt += dx * dt * w; yt += dy * dt * w }
  const det = xx * yy - xy * xy
  return { x, y, t, gx: det ? (xt * yy - yt * xy) / det : 0, gy: det ? (yt * xx - xt * xy) / det : 0 }
}
/** Warp each facial outline through the same UV mesh as the live renderer.
 * This emits the artwork once instead of repeating it in every mesh triangle. */
export function faceProjector(face: Snapshot['face'], project: (point: THREE.Vector3) => Point): ProjectPoint {
  const { widthSegments: nx, heightSegments: ny } = face.geometry.parameters
  const position = face.geometry.getAttribute('position')
  return p => {
    const u = p.x / 512 * nx, v = p.y / 512 * ny
    const ix = Math.max(0, Math.min(nx - 1, Math.floor(u))), iy = Math.max(0, Math.min(ny - 1, Math.floor(v))), fx = u - ix, fy = v - iy
    const a = ix + iy * (nx + 1), b = a + nx + 1, c = b + 1, d = a + 1
    const indices = fx + fy <= 1 ? [a, d, b] : [c, b, d], weights = fx + fy <= 1 ? [1 - fx - fy, fx, fy] : [fx + fy - 1, 1 - fx, 1 - fy]
    const value = new THREE.Vector3()
    indices.forEach((index, i) => value.addScaledVector(new THREE.Vector3().fromBufferAttribute(position, index), weights[i]!))
    return project(value.applyMatrix4(face.matrixWorld))
  }
}

export function snapshotSvg(snapshot: Snapshot, prefix = `cliplab-${crypto.randomUUID()}-`): string {
  const { character, sample, camera, options, body, lightFill, face, prop, shadow } = snapshot
  const { width, height } = options
  const defs: string[] = [], contents: string[] = []
  const project = (p: THREE.Vector3) => { const v = p.clone().project(camera); return { x: (v.x + 1) * width / 2, y: (1 - v.y) * height / 2, z: v.z, t: 0 } }
  const triangles = (mesh: THREE.Mesh, shading = false): { triangles: Triangle[]; vertices: Vertex[] } => {
    const geometry = mesh.geometry, position = geometry.getAttribute('position'), index = geometry.index
    const material = mesh.material as THREE.ShaderMaterial, uniforms = shading ? material.uniforms : undefined
    const angle = uniforms?.angle?.value ?? 0, bodyHeight = uniforms?.bodyHeight?.value ?? 1
    const scale = uniforms?.fillScale?.value as THREE.Vector3 | undefined, offset = uniforms?.fillOffset?.value as THREE.Vector3 | undefined
    const vertices: Vertex[] = []
    for (let i = 0; i < position.count; i++) {
      const local = new THREE.Vector3().fromBufferAttribute(position, i), v = project(local.clone().applyMatrix4(mesh.matrixWorld))
      if (shading) {
        local.multiply(scale ?? new THREE.Vector3(1, 1, 1)).add(offset ?? new THREE.Vector3())
        v.t = .5 + local.y / bodyHeight * Math.cos(angle) + local.x * Math.sin(angle)
      }
      vertices.push(v)
    }
    const triangles: Triangle[] = []
    for (let i = 0; i < (index?.count ?? position.count); i += 3) {
      const indices = [0, 1, 2].map(j => index ? index.getX(i + j) : i + j), points = indices.map(i => vertices[i]!)
      if (cross(points[0]!, points[1]!, points[2]!) < -1e-8) triangles.push({ points, indices })
    }
    return { triangles, vertices }
  }
  const shadedColor = (color: THREE.Color, shade: number) => '#' + color.clone().multiplyScalar(shade).getHexString()
  const outline = (vertices: Vertex[]) => pathData([{ points: hull(vertices), closed: true }])
  const surface = (mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>, label: string) => {
    const data = triangles(mesh, true), u = mesh.material.uniforms
    const colorA = u.colorA!.value as THREE.Color, colorB = (u.colorB!.value as THREE.Color).clone().lerp(colorA, 1 - u.gradientOn!.value)
    const shade = u.toonOn!.value && !u.insetFill!.value ? .8 : 1
    const gradient = fitGradient(data.triangles), { x, y, t, gx, gy } = gradient, length = gx * gx + gy * gy
    let fill = shadedColor(colorA, shade)
    if (u.gradientOn!.value > 0 && !colorA.equals(colorB)) {
      if (length < 1e-18) fill = shadedColor(colorB.clone().lerp(colorA, Math.max(0, Math.min(1, t))), shade)
      else {
        const id = `${label}-gradient`
        defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" color-interpolation="linearRGB" x1="${n(x - gx * t / length)}" y1="${n(y - gy * t / length)}" x2="${n(x + gx * (1 - t) / length)}" y2="${n(y + gy * (1 - t) / length)}"><stop stop-color="${shadedColor(colorB, shade)}"/><stop offset="1" stop-color="${shadedColor(colorA, shade)}"/></linearGradient>`)
        fill = `url(#${id})`
      }
    }
    contents.push(`<g id="${label}" data-name="${label === 'body' ? 'Outer body' : 'Inner body'}"><path fill="${fill}" d="${outline(data.vertices)}"/></g>`)
    return data
  }
  if (options.background) contents.push(`<rect width="${width}" height="${height}" fill="${xml(options.background)}"/>`)
  if (shadow.visible) {
    const material = shadow.material, data = triangles(shadow)
    contents.push(`<g id="ground-shadow" data-name="Shadow"><path d="${outline(data.vertices)}" fill="#${material.color.getHexString()}" opacity="${n(material.opacity)}"/></g>`)
  }
  const bodyData = surface(body, 'body')
  if (lightFill.visible) surface(lightFill, 'candle-light')
  const transparent: { z: number; markup: string }[] = []
  if (face.visible) {
    const art = new SvgCanvas('face', faceProjector(face, project))
    drawFace(art as unknown as CanvasRenderingContext2D, sample.pose, character, sample.blink, detailAt(options.displaySize ?? Math.min(width, height)), snapshot.gaze, { phase: sample.effectPhase, tearAmount: sample.tearAmount, eyeGazes: snapshot.eyeGazes, faceLayers: sample.faceLayers, simpleEyes: snapshot.simpleEyes })
    const valid = face.geometry.getAttribute('faceValid'), data = triangles(face)
    const visible = data.triangles.filter(t => t.indices.every(i => valid.getX(i) >= .99))
    defs.push(`<clipPath id="face-visible"><path d="${pathData(boundaryContours(visible.map(t => t.points)))}"/></clipPath>`)
    if (!face.geometry.boundingSphere) face.geometry.computeBoundingSphere()
    const center = project(face.geometry.boundingSphere!.center.clone().applyMatrix4(face.matrixWorld))
    transparent.push({ z: center.z, markup: `<g clip-path="url(#face-visible)">${art.markup()}</g>` })
  }
  if (prop.visible && prop.material.opacity > 0) {
    const art = new SvgCanvas('prop'), name = sample.pose.prop
    drawProp(art as unknown as CanvasRenderingContext2D, name, name === 'heart' ? '#ff768c' : name === 'sweat' ? '#b7e9ff' : '#ffd362', sample.effectPhase)
    const center = project(prop.getWorldPosition(new THREE.Vector3())), scale = prop.getWorldScale(new THREE.Vector3())
    const w = scale.x * width / (camera.right - camera.left), h = scale.y * height / (camera.top - camera.bottom)
    const foreground = !prop.material.depthTest
    if (!foreground) {
      const occlusion = pathData(boundaryContours(bodyData.triangles.map(t => clip(t.points, center.z, false)).filter(p => p.length >= 3)))
      defs.push(`<mask id="prop-occlusion" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="white"/><path d="${occlusion}" fill="black"/></mask>`)
    }
    transparent.push({ z: foreground ? -Infinity : center.z, markup: `<g id="supporting-elements" data-name="Supporting elements"${foreground ? '' : ' mask="url(#prop-occlusion)"'} opacity="${n(prop.material.opacity)}"><g transform="translate(${n(center.x - w / 2)} ${n(center.y - h / 2)}) scale(${n(w / 256)} ${n(h / 256)})">${art.markup()}</g></g>` })
  }
  if (transparent.length) contents.push(`<g id="face" data-name="Facial expression">${transparent.sort((a, b) => b.z - a.z).map(layer => layer.markup).join('')}</g>`)
  const metadata = { format: 'cliplab-svg-snapshot', gradientProjection: 'planar-fit', character, pose: sample.pose, gradientRotation: sample.gradientRotation ?? 0, effectiveGradientAngle: character.gradientAngle + (sample.gradientRotation ?? 0), rotation: options.rotation, cursor: options.cursor }
  // Multiple downloaded characters can safely be placed inline in the same page.
  const artwork = (`<defs>${defs.join('')}</defs>${contents.join('')}`)
    .replace(/\bid="([^"]+)"/g, (_, id: string) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${prefix}${id})`)
    .replace(/href="#([^"]+)"/g, (_, id: string) => `href="#${prefix}${id}"`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${xml(character.name)} — ClipLab snapshot</title><metadata>${xml(JSON.stringify(metadata))}</metadata>${artwork}</svg>`
}
