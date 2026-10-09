export interface Agenda<T> {
  readonly size: number
  push(at: number, item: T): void
  next(): number | undefined
  peek(): T | undefined
  take(now: number): T | undefined
}

interface Entry<T> {
  readonly at: number
  readonly order: number
  readonly item: T
}

export function createAgenda<T>(): Agenda<T> {
  const heap: Entry<T>[] = []
  let order = 0

  function push(at: number, item: T): void {
    const entry = { at, order: order++, item }
    let index = heap.length
    heap.push(entry)
    while (index > 0) {
      const parentIndex = (index - 1) >> 1
      const parent = heap[parentIndex]
      if (!parent || !earlier(entry, parent)) break
      heap[index] = parent
      index = parentIndex
    }
    heap[index] = entry
  }

  function take(now: number): T | undefined {
    const first = heap[0]
    if (!first || first.at > now) return undefined
    const last = heap.pop()
    if (heap.length > 0 && last) sink(last)
    return first.item
  }

  function sink(entry: Entry<T>): void {
    let index = 0
    for (;;) {
      const childIndex = earlierChild(index)
      const child = heap[childIndex]
      if (!child || !earlier(child, entry)) break
      heap[index] = child
      index = childIndex
    }
    heap[index] = entry
  }

  function earlierChild(index: number): number {
    const left = 2 * index + 1
    const leftEntry = heap[left]
    const rightEntry = heap[left + 1]
    return rightEntry && leftEntry && earlier(rightEntry, leftEntry) ? left + 1 : left
  }

  return {
    get size() {
      return heap.length
    },
    push,
    next: () => heap[0]?.at,
    peek: () => heap[0]?.item,
    take,
  }
}

function earlier<T>(a: Entry<T>, b: Entry<T>): boolean {
  return a.at < b.at || (a.at === b.at && a.order < b.order)
}
