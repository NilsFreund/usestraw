// Writes into output and returns how many samples it wrote; the rest waits for the next call
export type Resampler = (input: Float32Array, output: Float32Array) => number

// Polyphase windowed sinc: flat to 3.4 kHz at 8 kHz, aliases and images of that band 75 dB down.
// The AudioWorklet gets this function as source text, so it uses nothing outside its own body.
export function createResampler(from: number, to: number): Resampler {
  const divisor = (a: number, b: number): number => (b === 0 ? a : divisor(b, a % b))
  // The band ends at 0.925 of the lower Nyquist, with 32 taps a side at the lower rate, Kaiser β 7
  const BAND = 0.4625
  const SIDE = 32
  const BETA = 7
  const common = divisor(from, to)
  const up = to / common
  const down = from / common
  const lower = Math.min(from, to)
  const phases = Math.min(up, 512)
  const cutoff = (BAND * lower) / from
  const half = Math.ceil((SIDE * from) / lower)
  const taps = 2 * half
  const bessel = (x: number): number => {
    let sum = 1
    let term = 1
    for (let k = 1; k < 30; k++) {
      const step = x / (2 * k)
      term *= step * step
      sum += term
    }
    return sum
  }
  const table = new Float32Array(phases * taps)
  for (let phase = 0; phase < phases; phase++) {
    const row = table.subarray(phase * taps, (phase + 1) * taps)
    for (let tap = 0; tap < taps; tap++) {
      const time = tap - half + 1 - phase / phases
      const x = 2 * cutoff * time
      const edge = time / half
      const taper = bessel(BETA * Math.sqrt(Math.max(0, 1 - edge * edge))) / bessel(BETA)
      row[tap] = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * taper
    }
    const gain = row.reduce((sum, value) => sum + value, 0)
    for (let tap = 0; tap < taps; tap++) row[tap] = (row[tap] as number) / gain
  }
  let history = new Float32Array(2 * taps)
  let length = half - 1
  let at = half - 1
  let step = 0
  return (input, output) => {
    if (length + input.length > history.length) {
      const grown = new Float32Array(2 * (length + input.length))
      grown.set(history.subarray(0, length))
      history = grown
    }
    history.set(input, length)
    length += input.length
    let count = 0
    while (at + half < length && count < output.length) {
      const start = at - half + 1
      const row = Math.floor((step * phases) / up) * taps
      let sum = 0
      for (let tap = 0; tap < taps; tap++) {
        sum += (history[start + tap] as number) * (table[row + tap] as number)
      }
      output[count++] = sum
      step += down
      at += Math.floor(step / up)
      step %= up
    }
    const keep = at - half + 1
    history.copyWithin(0, keep, length)
    length -= keep
    at -= keep
    return count
  }
}
