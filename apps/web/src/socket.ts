import { io, Socket } from "socket.io-client";

const apiUrl = import.meta.env.VITE_API_URL || `http://${window.location.hostname}:3001`;

export const socket: Socket = io(apiUrl);
