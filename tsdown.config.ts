import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/node/index.ts"],
  platform: "neutral",
  deps: { neverBundle: [/^node:/] },
  dts: true,
  exports: true,
  publint: true,
  attw: { profile: "esm-only", level: "error" },
})
