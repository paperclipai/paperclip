/** Ensures only one issue audio attachment plays at a time. */
let activeAudio: HTMLAudioElement | null = null;

export function claimAudioPlayback(element: HTMLAudioElement): void {
  if (activeAudio && activeAudio !== element && !activeAudio.paused) {
    activeAudio.pause();
  }
  activeAudio = element;
}

export function releaseAudioPlayback(element: HTMLAudioElement): void {
  if (activeAudio === element) {
    activeAudio = null;
  }
}

/** @internal Test helper */
export function resetAudioPlaybackCoordinatorForTests(): void {
  activeAudio = null;
}
