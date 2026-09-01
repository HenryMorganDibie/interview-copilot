import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  // Tauri expects a fixed port and fails if it's not available.
  server: {
    port: 1420,
    strictPort: true,
  },
  // Env variables prefixed with VITE_ are exposed to the frontend.
  // Never prefix secrets (API keys) with VITE_.
  envPrefix: ["VITE_"],
  build: {
    target: "chrome105",
    minify: (process.env.TAURI_ENV_DEBUG ? false : "esbuild") as "esbuild" | false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
