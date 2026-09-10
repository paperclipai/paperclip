// ClipLab runtime adapted for Paperclip; geometry/animation model remain upstream.
// See PROVENANCE.md and LICENSE.
import { CharacterRenderer } from './renderer.js'
import { sampleDefinition, animationDuration, type Definition } from './model.js'
import { centeredGaze, easeGaze, pointerGaze } from './gaze.js'
export interface CharacterOptions {
  animation?: string; followCursor?: boolean; followRotation?: boolean;
  trackingRegion?: HTMLElement; trackingScope?: 'region' | 'page'; displaySize?: number; onComplete?: () => void; onError?: () => void;
}

/** One renderer; no frame callbacks or pointer listeners while hidden. */
export function createCharacter(target: HTMLElement, definition: Definition, options: CharacterOptions = {}) {
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:pan-y;'
  canvas.setAttribute('aria-hidden', 'true')
  const renderer = new CharacterRenderer(canvas, { width: target.clientWidth || 256, height: target.clientHeight || 256, displaySize: options.displaySize, framing: 'character' })
  target.appendChild(canvas)
  let animation = options.animation ?? 'idle', elapsed = 0, last = 0, raf = 0
  let visible = false, destroyed = false, playing = true, tracking = false
  let gaze = centeredGaze(), goal = centeredGaze()
  const region = options.trackingScope === 'page' ? target.ownerDocument.documentElement : options.trackingRegion ?? target
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const coarse = window.matchMedia('(pointer: coarse)')
  const canRun = () => !destroyed && visible && !document.hidden && !reduced.matches
  const render = () => renderer.render({ ...definition.character, followCursor: options.followCursor !== false, followRotation: options.followRotation !== false }, sampleDefinition(definition, animation, elapsed), { cursor: gaze, reducedMotion: reduced.matches }, gaze)
  const pointer = (event: PointerEvent) => { if (event.pointerType !== 'touch') goal = pointerGaze(event, target.getBoundingClientRect()) }
  const leave = () => { goal = centeredGaze() }
  function track(enabled: boolean) {
    if (tracking === enabled) return
    tracking = enabled
    if (enabled) { region.addEventListener('pointermove', pointer, { passive: true }); region.addEventListener('pointerleave', leave) }
    else { region.removeEventListener('pointermove', pointer); region.removeEventListener('pointerleave', leave); goal = centeredGaze() }
  }
  function sync() {
    cancelAnimationFrame(raf); raf = 0
    track(canRun() && !coarse.matches && (options.followCursor !== false || options.followRotation !== false))
    if (canRun() && playing) { last = performance.now(); raf = requestAnimationFrame(frame) }
  }
  function frame(now: number) {
    if (!canRun()) { sync(); return }
    const seconds = Math.min((now - last) / 1000, .1); last = now
    elapsed += seconds; gaze = easeGaze(gaze, goal, seconds, false)
    try { render() } catch { playing = false; sync(); options.onError?.(); return }
    const selected = definition.animations.find(a => a.id === animation)
    if (selected && !selected.loop && elapsed * definition.character.speed >= animationDuration(selected)) {
      animation = 'idle'; elapsed = 0; options.onComplete?.()
    }
    raf = requestAnimationFrame(frame)
  }
  function renderSafely() {
    if (destroyed) return
    try { render() } catch { playing = false; sync(); options.onError?.() }
  }
  const resize = new ResizeObserver(() => {
    try { renderer.resize(target.clientWidth || 256, target.clientHeight || 256, options.displaySize); if (visible) renderSafely() }
    catch { playing = false; sync(); options.onError?.() }
  })
  const intersection = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? false; sync() })
  const contextLost = (event: Event) => { event.preventDefault(); playing = false; sync(); options.onError?.() }
  function destroy() {
    if (destroyed) return
    destroyed = true; sync(); resize.disconnect(); intersection.disconnect()
    document.removeEventListener('visibilitychange', sync); reduced.removeEventListener('change', sync); coarse.removeEventListener('change', sync)
    canvas.removeEventListener('webglcontextlost', contextLost); renderer.dispose(); canvas.remove()
  }
  try {
    resize.observe(target); intersection.observe(target)
    document.addEventListener('visibilitychange', sync); reduced.addEventListener('change', sync); coarse.addEventListener('change', sync)
    canvas.addEventListener('webglcontextlost', contextLost)
    render()
  } catch (error) { destroy(); throw error }

  return {
    setAnimation(id: string) { if (animation === id) return; animation = id; elapsed = 0; renderSafely() },
    setDefinition(value: Definition) { definition = value; renderSafely() },
    seek(seconds: number) { elapsed = Math.max(0, seconds); renderSafely() },
    pause() { playing = false; sync() },
    play() { playing = true; sync() },
    destroy,

  }
}
