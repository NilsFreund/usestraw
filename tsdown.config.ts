import { defineConfig } from "tsdown"

export default defineConfig({
  entry: { index: "src/node/index.ts", core: "src/index.ts" },
  platform: "neutral",
  deps: { neverBundle: [/^node:/] },
  dts: true,
  exports: true,
  publint: true,
  attw: { profile: "esm-only", level: "error" },
})
