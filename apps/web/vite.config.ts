import { defineConfig } from "vite-plus";

/** Matches the server's own default; override to proxy at a second instance. */
const apiPort = process.env.LHC_CONSOLE_PORT ?? "5959";

export default defineConfig({
  server: {
    // Dev box is reached over Tailscale; the API stays loopback-only and is
    // reached through this proxy.
    host: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}`, ws: true },
    },
  },
});
