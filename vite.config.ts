import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * `base` is set from BASE_PATH so a GitHub Pages project site can be served from /<repo>/.
 * VITE_STATIC=1 selects the in-browser chain instead of the local Node server.
 */
export default defineConfig({
  root: fileURLToPath(new URL("./src/web", import.meta.url)),
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  define: { global: "globalThis" },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
});
