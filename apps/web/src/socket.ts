import { io, Socket } from "socket.io-client";

const rawBase = (import.meta.env.VITE_API_URL || window.location.origin).trim();
const apiBase = rawBase.replace(/\/$/, "");

export const socket: Socket = io(apiBase, {
  path: "/socket.io",
});
