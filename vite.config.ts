import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2021",
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        pet: resolve(root, "pet.html"),
        break: resolve(root, "break.html"),
      },
    },
  },
});
