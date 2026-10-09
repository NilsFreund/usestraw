import { defineConfig } from "tsdown"

export default defineConfig({
  entry: "src/index.ts",
  platform: "neutral",
  dts: true,
  exports: true,
  publint: true,
  attw: { profile: "esm-only", level: "error" },
})
