export function words32(hex: string): DataView {
  const values = hex.trim().split(/\s+/)
  const view = new DataView(new ArrayBuffer(values.length * 4))
  for (const [index, value] of values.entries()) view.setUint32(index * 4, Number(`0x${value}`))
  return view
}

export function words64(hex: string): DataView {
  const values = hex.trim().split(/\s+/)
  const view = new DataView(new ArrayBuffer(values.length * 8))
  for (const [index, value] of values.entries()) view.setBigUint64(index * 8, BigInt(`0x${value}`))
  return view
}
