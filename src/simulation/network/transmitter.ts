export interface Transmitter {
  readonly busyUntil: number
  send(size: number, at: number): number | undefined
}

export function createTransmitter(
  bandwidth: number | undefined,
  buffer: number | undefined,
  busySince = 0,
): Transmitter {
  let busyUntil = busySince

  function send(size: number, at: number): number | undefined {
    if (bandwidth === undefined) return at
    const backlog = (Math.max(0, busyUntil - at) * bandwidth) / 8000
    if (buffer !== undefined && backlog > 0 && backlog + size > buffer) return undefined
    busyUntil = Math.max(at, busyUntil) + (size * 8000) / bandwidth
    return busyUntil
  }

  return {
    get busyUntil() {
      return busyUntil
    },
    send,
  }
}
