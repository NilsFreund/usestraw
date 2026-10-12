// Browsers without the symbol get the one esbuild and Babel fall back to for `await using`
export const asyncDispose: typeof Symbol.asyncDispose =
  Symbol.asyncDispose ?? (Symbol.for("Symbol.asyncDispose") as typeof Symbol.asyncDispose)
