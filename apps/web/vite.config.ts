import { defineConfig } from "vite-plus";

export default defineConfig({
  server: {
    // Dev box is reached over Tailscale; the API stays loopback-only and is
    // reached through this proxy.
    host: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:5959", ws: true },
    },
  },
});
