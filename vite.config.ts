import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The hub's server runs on port 8787. In development, Vite serves the page
// on 5173 and forwards /api calls to the server.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
});
