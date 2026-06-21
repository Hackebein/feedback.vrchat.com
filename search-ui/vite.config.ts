import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/web"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        openapi: path.resolve(import.meta.dirname, "openapi.html"),
      },
    },
  },
  server: {
    proxy: {
      // More specific prefix first so notification API calls reach the Go
      // service instead of the search gateway.
      "/api/notify": {
        target: "http://127.0.0.1:3334",
        changeOrigin: true,
      },
      "/api": {
        target: "http://127.0.0.1:3333",
        changeOrigin: true,
      },
    },
  },
});
