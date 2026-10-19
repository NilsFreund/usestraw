const GESTURES = ["pointerdown", "keydown", "touchend"]

// Browsers start audio only after a click or key press: retry runs on each one until stopped
export function onGestures(page: EventTarget | undefined, retry: () => void): () => void {
  for (const type of GESTURES) page?.addEventListener(type, retry, { capture: true, passive: true })
  return () => {
    for (const type of GESTURES) page?.removeEventListener(type, retry, { capture: true })
  }
}
