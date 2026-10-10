interface MobileNavScrollOptions {
  topZone: number;
  hideDistance: number;
  showDistance: number;
}

/** Accumulate deliberate scrolling, independent of scroll-event frequency. */
export class MobileNavScrollTracker {
  visible = true;
  private direction = 0;
  private distance = 0;

  constructor(
    private options: MobileNavScrollOptions,
    private lastTop: number,
    private lastMaxTop: number,
  ) {}

  /** Follow the scroll position without counting it as a swipe. */
  sync(scrollTop: number, maxTop: number): void {
    this.lastTop = Math.max(0, Math.min(scrollTop, maxTop));
    this.lastMaxTop = maxTop;
    this.direction = 0;
    this.distance = 0;
  }

  update(scrollTop: number, maxTop: number): boolean {
    // Safari rubber-banding must not count as a change in scroll direction.
    const top = Math.max(0, Math.min(scrollTop, maxTop));
    const delta = top - Math.max(this.lastTop, this.options.topZone);
    const boundsChanged = maxTop !== this.lastMaxTop;
    this.lastTop = top;
    this.lastMaxTop = maxTop;

    if (top <= this.options.topZone) {
      this.visible = true;
      this.direction = 0;
      this.distance = 0;
    } else if (boundsChanged) {
      // Content loading or the keyboard resizing the viewport is not a swipe.
      this.direction = 0;
      this.distance = 0;
    } else if (delta !== 0) {
      const direction = Math.sign(delta);
      if (direction !== this.direction) this.distance = 0;
      this.direction = direction;
      this.distance += Math.abs(delta);
      const threshold = direction > 0 ? this.options.hideDistance : this.options.showDistance;
      if (this.distance >= threshold) {
        this.visible = direction < 0;
        this.distance = 0;
      }
    }

    return this.visible;
  }
}
