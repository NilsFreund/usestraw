/**
 * The browser build of `usestraw`, a placeholder until the browser softphone ships: `connect()`
 * rejects with a `NotSupportedError`. Where Node APIs are available, as in jsdom tests or Electron
 * with Node integration, import `usestraw/node`.
 *
 * @module
 */
import type { Phone } from "./phone/phone"

export { ConnectError } from "./phone/connect-error"

/** Not in browsers yet: rejects with a `NotSupportedError`. */
export async function connect(): Promise<Phone> {
  throw new DOMException(
    "Straw runs in Node only for now. Where Node APIs are available, import usestraw/node",
    "NotSupportedError",
  )
}
