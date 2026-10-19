/**
 * The browser build of `usestraw`: the same phone, over WebSocket, with calls through WebRTC. In
 * Electron's main process or a `utilityProcess`, or in jsdom tests, import `usestraw/node`.
 *
 * @module
 */
export { ConnectError } from "./phone/connect-error"
export { connect } from "./web/connect"
