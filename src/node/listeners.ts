export interface Listeners {
  subscribe(listener: () => void): () => void
  notify(): void
}

export function createListeners(): Listeners {
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener) => {
      const entry = () => listener()
      listeners.add(entry)
      return () => {
        listeners.delete(entry)
      }
    },
    notify: () => {
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue
        try {
          listener()
        } catch (error) {
          queueMicrotask(() => {
            throw error
          })
        }
      }
    },
  }
}
