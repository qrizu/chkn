import { io, Socket } from "socket.io-client";

function normalizeBasePath(value: string | undefined): string {
  const cleaned = String(value || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  return cleaned ? `/${cleaned}` : "";
}

function detectRuntimePrefix(pathname: string): string {
  if (pathname === "/stardom" || pathname.startsWith("/stardom/")) return "/stardom";
  if (pathname === "/chickenrace" || pathname.startsWith("/chickenrace/")) return "/chickenrace";
  if (pathname === "/silent-disco" || pathname.startsWith("/silent-disco/")) return "/silent-disco";
  if (pathname === "/chicken" || pathname.startsWith("/chicken/")) return "/chicken";
  if (pathname === "/chkn" || pathname.startsWith("/chkn/")) return "/chkn";
  return "";
}

function resolveSocketTarget() {
  const configured = (import.meta.env.VITE_API_URL || "").trim();
  const runtimePrefix = detectRuntimePrefix(window.location.pathname || "/") || normalizeBasePath(import.meta.env.VITE_APP_BASE);

  if (!configured) {
    return {
      origin: window.location.origin,
      path: `${runtimePrefix}/socket.io` || "/socket.io",
    };
  }

  if (/^https?:\/\//i.test(configured)) {
    const parsed = new URL(configured);
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    const prefix = cleanPath.endsWith("/api") ? cleanPath.slice(0, -4) : cleanPath;
    return {
      origin: parsed.origin,
      path: `${prefix}/socket.io` || "/socket.io",
    };
  }

  const clean = configured.replace(/\/+$/, "");
  const prefixed = clean.endsWith("/api") ? clean.slice(0, -4) : clean;
  const path = prefixed ? `${prefixed}/socket.io` : "/socket.io";
  return {
    origin: window.location.origin,
    path: path.startsWith("/") ? path : `/${path}`,
  };
}

const socketTarget = resolveSocketTarget();

export const socket: Socket = io(socketTarget.origin, {
  path: socketTarget.path,
});
