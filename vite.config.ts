import { existsSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The hub's server runs on port 8787 (or HUB_PORT from .env). In development,
// Vite serves the page on 5173 and forwards /api calls to the server.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    // changeOrigin stays off so the server's cross-site check sees the page's
    // own address (localhost:5173) and lets its changes through.
    proxy: { "/api": { target: `http://localhost:${process.env.HUB_PORT || 8787}`, changeOrigin: false } },
  },
});
