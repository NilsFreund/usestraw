// FNV-1a, 32 bit (draft-eastlake-fnv)
export function fnv1a(text: string): number {
  let value = 0x811c9dc5
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193)
  return value >>> 0
}
