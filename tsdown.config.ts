import { defineConfig } from "tsdown"

export default defineConfig({
  entry: { index: "src/index.ts", core: "src/core.ts", browser: "src/browser.ts" },
  platform: "neutral",
  deps: { neverBundle: [/^node:/] },
  dts: true,
  // Phone and Call extend AsyncDisposable, which DOM-only projects don't load by themselves
  banner: { dts: '/// <reference lib="esnext.disposable" />' },
  // Shared chunks get the package's name, so stack traces don't point at whatever module came first
  outputOptions: {
    chunkFileNames: (chunk) => (chunk.name.endsWith(".d") ? "[name].ts" : "straw-[hash].js"),
  },
  publint: true,
  attw: { profile: "esm-only", level: "error" },
})
