/**
 * The browser build of `usestraw`, a placeholder until the browser softphone ships: `connect()`
 * rejects with a `NotSupportedError`. Where Node runs, as in Electron's main process or a
 * `utilityProcess`, or in jsdom tests, import `usestraw/node`.
 *
 * @module
 */
import type { Phone } from "./phone/types"

export { ConnectError } from "./phone/connect-error"

/** Not in browsers yet: rejects with a `NotSupportedError`. */
export async function connect(): Promise<Phone> {
  throw new DOMException(
    "Straw runs in Node only for now. Where Node APIs are available, import usestraw/node",
    "NotSupportedError",
  )
}
