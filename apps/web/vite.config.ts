import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: ["chkn-dev.sputnet.world", "chkn.sputnet.world", "chkn.veloklang.se"],
  },
});
