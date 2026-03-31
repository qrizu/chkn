import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const base = (process.env.VITE_BASE_PATH || "/").trim() || "/";

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: ["chkn.sputnet.world", "chkn.veloklang.se"],
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Surrogate-Control": "no-store",
    },
  },
});
