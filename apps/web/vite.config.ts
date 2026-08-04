import { defineConfig } from "vite-plus";

/** Matches the server's own default; override to proxy at a second instance. */
const apiPort = process.env.LHC_CONSOLE_PORT ?? "5959";

export default defineConfig({
  server: {
    // Dev box is reached over Tailscale; the API stays loopback-only and is
    // reached through this proxy.
    host: true,
    // Vite allows IP Host headers but blocks DNS names it doesn't know, so
    // the tailnet MagicDNS name needs listing. Suffix form covers renames.
    allowedHosts: [".ts.net"],
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}`, ws: true },
    },
  },
});
