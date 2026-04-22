import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type http from "node:http";
import type { Server, Socket } from "socket.io";

type AuthHeaders = Record<string, string>;

type Identity = {
  userId: string;
  username: string | null;
  displayName: string;
  email: string | null;
};

type SourceKind = "upload" | "stream" | "spotify" | "soundcloud";

type LinkRole = "listener" | "host";

type SilentDiscoSource = {
  kind: SourceKind;
  title: string;
  url: string;
  mimeType: string | null;
  mediaId: string | null;
  setByUserId: string;
};

type MediaAsset = {
  id: string;
  filePath: string;
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  uploadedByUserId: string;
  createdAt: number;
};

type SilentDiscoRoom = {
  roomCode: string;
  hostUserId: string;
  hostDisplayName: string;
  source: SilentDiscoSource | null;
  playing: boolean;
  positionMs: number;
  updatedAtMs: number;
  lastTouchedAtMs: number;
  members: Map<string, Identity>;
};

type RoomSnapshot = {
  roomCode: string;
  hostUserId: string;
  hostDisplayName: string;
  source: SilentDiscoSource | null;
  playing: boolean;
  positionMs: number;
  serverNowMs: number;
  listenerCount: number;
  listenerUserCount: number;
  listeners: Array<{ userId: string; displayName: string }>;
};

type ManagerDeps = {
  parseJsonBody: (req: http.IncomingMessage, maxBytes?: number) => Promise<any>;
  getAuthentikHeaders: (headers: Record<string, unknown>) => AuthHeaders;
};

type PersistedRoom = {
  roomCode: string;
  hostUserId: string;
  hostDisplayName: string;
  source: SilentDiscoSource | null;
  playing: boolean;
  positionMs: number;
  updatedAtMs: number;
  lastTouchedAtMs: number;
};

type PersistedState = {
  version: number;
  savedAt: number;
  rooms: PersistedRoom[];
  media: MediaAsset[];
};

type JoinTokenPayload = {
  type: "silent_disco_join";
  roomCode: string;
  role: LinkRole;
  hostUserId?: string;
};

const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const MAX_ROOMS = 400;
const MAX_ROOM_POSITION_MS = 12 * 60 * 60 * 1000;
const SILENT_DISCO_STATE_VERSION = 1;
const SILENT_DISCO_ROOM_IDLE_TTL_MS = Math.max(
  10 * 60 * 1000,
  Number(process.env.SILENT_DISCO_ROOM_IDLE_TTL_MS || 24 * 60 * 60 * 1000)
);
const SILENT_DISCO_MEDIA_IDLE_TTL_MS = Math.max(
  10 * 60 * 1000,
  Number(process.env.SILENT_DISCO_MEDIA_IDLE_TTL_MS || 7 * 24 * 60 * 60 * 1000)
);
const SILENT_DISCO_CLEANUP_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.SILENT_DISCO_CLEANUP_INTERVAL_MS || 10 * 60 * 1000)
);
const SILENT_DISCO_PERSIST_DEBOUNCE_MS = Math.max(
  100,
  Number(process.env.SILENT_DISCO_PERSIST_DEBOUNCE_MS || 350)
);

const SILENT_DISCO_UPLOAD_PAYLOAD_MAX_BYTES = Math.max(
  8_000_000,
  Number(process.env.SILENT_DISCO_UPLOAD_PAYLOAD_MAX_BYTES || 120_000_000)
);
const SILENT_DISCO_FILE_MAX_BYTES = Math.max(
  8_000_000,
  Number(process.env.SILENT_DISCO_FILE_MAX_BYTES || 80_000_000)
);
const SILENT_DISCO_LINK_TTL_SECONDS = Math.max(
  60,
  Number(process.env.SILENT_DISCO_LINK_TTL_SECONDS || 12 * 60 * 60)
);
const silentDiscoMediaDir = path.resolve(process.cwd(), ".silent-disco-media");
const silentDiscoStateFile = path.resolve(process.cwd(), ".silent-disco-state.json");

const extensionToMime: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
};

const mimeToExtension: Record<string, string> = Object.fromEntries(
  Object.entries(extensionToMime).map(([ext, mime]) => [mime, ext])
);

const normalizeRoomCode = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ROOM_CODE_LENGTH);

const normalizeMimeType = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .split(";")[0]
    .trim();

const clampPositionMs = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  return Math.min(Math.trunc(n), MAX_ROOM_POSITION_MS);
};

const normalizeDisplayName = (identity: Identity): string =>
  String(identity.displayName || identity.username || identity.userId).trim() || identity.userId;

const sanitizeFileName = (value: unknown): string => {
  const trimmed = String(value ?? "").trim();
  const safe = trimmed.replace(/[^0-9A-Za-z._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe.slice(0, 120) || "track";
};

const normalizeSourceTitle = (value: unknown, fallback: string): string => {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return text.slice(0, 140);
};

const normalizeAbsoluteHttpUrl = (value: unknown): string => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
};

const normalizeUploadUrlPath = (value: unknown): string => {
  const raw = String(value ?? "").trim();
  if (!raw.startsWith("/api/silent-disco/media/")) return "";
  return raw;
};

const extractMediaIdFromPath = (value: string): string => {
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith("/api/silent-disco/media/")) return "";
  const rest = trimmed.slice("/api/silent-disco/media/".length);
  return decodeURIComponent(rest.split("/")[0] || "").trim();
};

const parseBase64Payload = (value: unknown): string => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
};

const normalizeRole = (value: unknown): LinkRole => {
  const role = String(value ?? "listener").trim().toLowerCase();
  return role === "host" ? "host" : "listener";
};

const buildIdentityFromHeaders = (headers: AuthHeaders): Identity | null => {
  const userId = String(headers["x-authentik-uid"] || "").trim();
  if (!userId) return null;
  const username = String(headers["x-authentik-username"] || "").trim() || null;
  const name = String(headers["x-authentik-name"] || "").trim() || "";
  const displayName = name || username || userId;
  const email = String(headers["x-authentik-email"] || "").trim() || null;
  return {
    userId,
    username,
    displayName,
    email,
  };
};

const parsePersistedSource = (value: any, mediaLookup: Map<string, MediaAsset>): SilentDiscoSource | null => {
  if (!value || typeof value !== "object") return null;
  const kind = String(value.kind || "").trim().toLowerCase() as SourceKind;
  if (kind !== "upload" && kind !== "stream" && kind !== "spotify" && kind !== "soundcloud") return null;

  const title = normalizeSourceTitle(value.title, kind === "upload" ? "Uploaded track" : "Shared source");
  const url = String(value.url || "").trim();
  const mimeType = normalizeMimeType(value.mimeType) || null;
  const setByUserId = String(value.setByUserId || "").trim();

  if (!setByUserId) return null;

  if (kind === "upload") {
    const uploadPath = normalizeUploadUrlPath(url);
    const mediaId = extractMediaIdFromPath(uploadPath);
    if (!uploadPath || !mediaId || !mediaLookup.has(mediaId)) return null;
    return {
      kind,
      title,
      url: uploadPath,
      mimeType,
      mediaId,
      setByUserId,
    };
  }

  const absolute = normalizeAbsoluteHttpUrl(url);
  if (!absolute) return null;
  return {
    kind,
    title,
    url: absolute,
    mimeType,
    mediaId: null,
    setByUserId,
  };
};

const roomChannel = (roomCode: string) => `silent_disco:${roomCode}`;

const respondJson = (res: http.ServerResponse, statusCode: number, payload: unknown): void => {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
};

const parseRangeHeader = (rangeHeader: string, totalSize: number): { start: number; end: number } | null => {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;

  const rawStart = match[1];
  const rawEnd = match[2];

  if (!rawStart && !rawEnd) return null;

  let start = rawStart ? Number(rawStart) : NaN;
  let end = rawEnd ? Number(rawEnd) : NaN;

  if (!rawStart && rawEnd) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(totalSize - Math.trunc(suffixLength), 0);
    end = totalSize - 1;
  }

  if (rawStart && !rawEnd) {
    if (!Number.isFinite(start) || start < 0) return null;
    end = totalSize - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  start = Math.trunc(start);
  end = Math.trunc(end);

  if (start < 0 || end < 0 || start > end || start >= totalSize) return null;
  if (end >= totalSize) end = totalSize - 1;

  return { start, end };
};

const collectUniqueListeners = (
  members: Iterable<Identity>
): Array<{ userId: string; displayName: string }> => {
  const seen = new Set<string>();
  const listeners: Array<{ userId: string; displayName: string }> = [];

  for (const member of members) {
    if (!member?.userId || seen.has(member.userId)) continue;
    seen.add(member.userId);
    listeners.push({ userId: member.userId, displayName: normalizeDisplayName(member) });
  }

  return listeners;
};

const estimateCurrentPositionMs = (room: SilentDiscoRoom, nowMs = Date.now()): number => {
  if (!room.playing) return clampPositionMs(room.positionMs);
  const elapsed = Math.max(0, nowMs - room.updatedAtMs);
  return clampPositionMs(room.positionMs + elapsed);
};

const roomSnapshot = (room: SilentDiscoRoom): RoomSnapshot => {
  const serverNowMs = Date.now();
  const listeners = collectUniqueListeners(room.members.values());
  return {
    roomCode: room.roomCode,
    hostUserId: room.hostUserId,
    hostDisplayName: room.hostDisplayName,
    source: room.source,
    playing: room.playing,
    positionMs: estimateCurrentPositionMs(room, serverNowMs),
    serverNowMs,
    listenerCount: room.members.size,
    listenerUserCount: listeners.length,
    listeners,
  };
};

export const createSilentDiscoManager = ({ parseJsonBody, getAuthentikHeaders }: ManagerDeps) => {
  const rooms = new Map<string, SilentDiscoRoom>();
  const mediaAssets = new Map<string, MediaAsset>();
  const socketToRoom = new Map<string, string>();

  const linkSecret = (() => {
    const fromEnv = String(process.env.SILENT_DISCO_LINK_SECRET || "").trim();
    if (fromEnv) return fromEnv;
    return `silent-disco-dev-${randomUUID()}`;
  })();

  let persistTimer: NodeJS.Timeout | null = null;

  const markRoomTouched = (room: SilentDiscoRoom) => {
    room.lastTouchedAtMs = Date.now();
  };

  const emitRoomState = (io: Server, room: SilentDiscoRoom) => {
    io.to(roomChannel(room.roomCode)).emit("silent_disco:state", { room: roomSnapshot(room) });
  };

  const serializeState = (): PersistedState => {
    const persistedRooms: PersistedRoom[] = Array.from(rooms.values()).map((room) => ({
      roomCode: room.roomCode,
      hostUserId: room.hostUserId,
      hostDisplayName: room.hostDisplayName,
      source: room.source,
      playing: room.playing,
      positionMs: clampPositionMs(room.positionMs),
      updatedAtMs: Number(room.updatedAtMs || Date.now()),
      lastTouchedAtMs: Number(room.lastTouchedAtMs || Date.now()),
    }));

    const persistedMedia: MediaAsset[] = Array.from(mediaAssets.values());

    return {
      version: SILENT_DISCO_STATE_VERSION,
      savedAt: Date.now(),
      rooms: persistedRooms,
      media: persistedMedia,
    };
  };

  const persistStateNow = async (): Promise<void> => {
    try {
      const payload = JSON.stringify(serializeState(), null, 2);
      await fsPromises.mkdir(path.dirname(silentDiscoStateFile), { recursive: true });
      const tempPath = `${silentDiscoStateFile}.tmp`;
      await fsPromises.writeFile(tempPath, payload, "utf8");
      await fsPromises.rename(tempPath, silentDiscoStateFile);
    } catch {
      // Keep runtime alive even if persistence fails.
    }
  };

  const persistStateSoon = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistStateNow();
    }, SILENT_DISCO_PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  };

  const cleanupStaleData = async (force = false): Promise<void> => {
    const now = Date.now();
    let changed = false;

    for (const [roomCode, room] of rooms.entries()) {
      if (!force && room.members.size > 0) continue;
      if (now - room.lastTouchedAtMs > SILENT_DISCO_ROOM_IDLE_TTL_MS) {
        rooms.delete(roomCode);
        changed = true;
      }
    }

    const referencedMediaIds = new Set<string>();
    for (const room of rooms.values()) {
      if (room.source?.kind === "upload" && room.source.mediaId) {
        referencedMediaIds.add(room.source.mediaId);
      }
    }

    for (const [mediaId, media] of mediaAssets.entries()) {
      const isReferenced = referencedMediaIds.has(mediaId);
      const tooOld = now - media.createdAt > SILENT_DISCO_MEDIA_IDLE_TTL_MS;
      if (!isReferenced && tooOld) {
        mediaAssets.delete(mediaId);
        changed = true;
        try {
          await fsPromises.unlink(media.filePath);
        } catch {
          // Ignore stale file deletion issues.
        }
      }
    }

    if (changed) persistStateSoon();
  };

  const hydratePersistedState = () => {
    try {
      if (!fs.existsSync(silentDiscoStateFile)) return;
      const raw = fs.readFileSync(silentDiscoStateFile, "utf8");
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (!parsed || typeof parsed !== "object") return;

      const parsedMedia = Array.isArray(parsed.media) ? parsed.media : [];
      for (const value of parsedMedia) {
        const id = String((value as any)?.id || "").trim();
        const filePath = String((value as any)?.filePath || "").trim();
        const mimeType = normalizeMimeType((value as any)?.mimeType);
        const originalName = sanitizeFileName((value as any)?.originalName || "track");
        const sizeBytes = Math.max(0, Number((value as any)?.sizeBytes || 0));
        const uploadedByUserId = String((value as any)?.uploadedByUserId || "").trim();
        const createdAt = Number((value as any)?.createdAt || Date.now());

        if (!id || !filePath || !mimeType || !uploadedByUserId) continue;
        if (!fs.existsSync(filePath)) continue;

        mediaAssets.set(id, {
          id,
          filePath,
          mimeType,
          originalName,
          sizeBytes,
          uploadedByUserId,
          createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        });
      }

      const parsedRooms = Array.isArray(parsed.rooms) ? parsed.rooms : [];
      for (const value of parsedRooms) {
        const roomCode = normalizeRoomCode((value as any)?.roomCode);
        const hostUserId = String((value as any)?.hostUserId || "").trim();
        const hostDisplayName = String((value as any)?.hostDisplayName || hostUserId).trim() || hostUserId;
        if (!roomCode || !hostUserId) continue;

        const source = parsePersistedSource((value as any)?.source, mediaAssets);
        const playing = Boolean((value as any)?.playing && source);
        const positionMs = clampPositionMs((value as any)?.positionMs || 0);
        const updatedAtMsRaw = Number((value as any)?.updatedAtMs || Date.now());
        const lastTouchedRaw = Number((value as any)?.lastTouchedAtMs || updatedAtMsRaw || Date.now());

        rooms.set(roomCode, {
          roomCode,
          hostUserId,
          hostDisplayName,
          source,
          playing,
          positionMs,
          updatedAtMs: Number.isFinite(updatedAtMsRaw) ? updatedAtMsRaw : Date.now(),
          lastTouchedAtMs: Number.isFinite(lastTouchedRaw) ? lastTouchedRaw : Date.now(),
          members: new Map(),
        });
      }
    } catch {
      // Ignore corrupt persistence state and continue with an empty runtime.
    }
  };

  const startCleanupLoop = () => {
    const timer = setInterval(() => {
      void cleanupStaleData();
    }, SILENT_DISCO_CLEANUP_INTERVAL_MS);
    timer.unref?.();
  };

  const getOrCreateRoomCode = (): string => {
    for (let i = 0; i < 80; i += 1) {
      let candidate = "";
      for (let j = 0; j < ROOM_CODE_LENGTH; j += 1) {
        const idx = Math.floor(Math.random() * ROOM_CODE_CHARS.length);
        candidate += ROOM_CODE_CHARS[idx];
      }
      if (!rooms.has(candidate)) return candidate;
    }
    return randomUUID().replace(/-/g, "").toUpperCase().slice(0, ROOM_CODE_LENGTH);
  };

  const signJoinToken = (roomCode: string, role: LinkRole, hostUserId: string): string => {
    const payload: JoinTokenPayload = {
      type: "silent_disco_join",
      roomCode,
      role,
      ...(role === "host" ? { hostUserId } : {}),
    };
    return jwt.sign(payload, linkSecret, {
      algorithm: "HS256",
      expiresIn: SILENT_DISCO_LINK_TTL_SECONDS,
    });
  };

  const verifyJoinToken = (
    token: string,
    expectedRoomCode: string
  ): { ok: true; role: LinkRole; hostUserId: string | null } | { ok: false; error: string } => {
    try {
      const decoded = jwt.verify(token, linkSecret, {
        algorithms: ["HS256"],
      });
      if (!decoded || typeof decoded !== "object") {
        return { ok: false, error: "join_token_invalid" };
      }

      const payload = decoded as Record<string, unknown>;
      const tokenType = String(payload.type || "").trim();
      if (tokenType !== "silent_disco_join") {
        return { ok: false, error: "join_token_invalid" };
      }

      const tokenRoomCode = normalizeRoomCode(payload.roomCode);
      if (!tokenRoomCode || tokenRoomCode !== expectedRoomCode) {
        return { ok: false, error: "join_token_room_mismatch" };
      }

      const role = normalizeRole(payload.role);
      const hostUserId = role === "host" ? String(payload.hostUserId || "").trim() : "";
      if (role === "host" && !hostUserId) {
        return { ok: false, error: "join_token_invalid" };
      }

      return {
        ok: true,
        role,
        hostUserId: hostUserId || null,
      };
    } catch (err) {
      const name = String((err as { name?: string })?.name || "");
      if (name === "TokenExpiredError") {
        return { ok: false, error: "join_token_expired" };
      }
      return { ok: false, error: "join_token_invalid" };
    }
  };

  const ensureHostOwnership = (socket: Socket, identity: Identity | null, room: SilentDiscoRoom): boolean => {
    if (!identity?.userId) {
      socket.emit("silent_disco:error", { error: "unauthorized" });
      return false;
    }
    if (room.hostUserId !== identity.userId) {
      socket.emit("silent_disco:error", { error: "only_host" });
      return false;
    }
    return true;
  };

  const removeSocketFromRoom = (io: Server, socket: Socket) => {
    const roomCode = socketToRoom.get(socket.id);
    if (!roomCode) return;

    socketToRoom.delete(socket.id);
    socket.leave(roomChannel(roomCode));

    const room = rooms.get(roomCode);
    if (!room) return;

    room.members.delete(socket.id);
    markRoomTouched(room);

    if (room.members.size === 0) {
      room.positionMs = estimateCurrentPositionMs(room);
      room.playing = false;
      room.updatedAtMs = Date.now();
      persistStateSoon();
      return;
    }

    const hostStillInRoom = Array.from(room.members.values()).some((member) => member.userId === room.hostUserId);
    if (!hostStillInRoom) {
      const nextHost = room.members.values().next().value as Identity | undefined;
      if (nextHost) {
        room.hostUserId = nextHost.userId;
        room.hostDisplayName = normalizeDisplayName(nextHost);
      }
    }

    emitRoomState(io, room);
    persistStateSoon();
  };

  const joinSocketToRoom = (io: Server, socket: Socket, room: SilentDiscoRoom, identity: Identity) => {
    removeSocketFromRoom(io, socket);
    socket.join(roomChannel(room.roomCode));
    socketToRoom.set(socket.id, room.roomCode);
    room.members.set(socket.id, identity);
    markRoomTouched(room);
    if (room.hostUserId === identity.userId) {
      room.hostDisplayName = normalizeDisplayName(identity);
    }
    emitRoomState(io, room);
    persistStateSoon();
  };

  const parseRoomFromPayload = (payload: any): string => normalizeRoomCode(payload?.roomCode);

  const resolveRoomForSocket = (socket: Socket, payload?: any): SilentDiscoRoom | null => {
    const explicitCode = parseRoomFromPayload(payload);
    const joinedCode = socketToRoom.get(socket.id) || "";
    const roomCode = explicitCode || joinedCode;
    if (!roomCode) return null;
    return rooms.get(roomCode) ?? null;
  };

  const parseSource = (
    input: any,
    identity: Identity,
    mediaLookup: Map<string, MediaAsset>
  ): { ok: true; source: SilentDiscoSource } | { ok: false; error: string } => {
    const kind = String(input?.kind || "").trim().toLowerCase() as SourceKind;
    if (kind !== "upload" && kind !== "stream" && kind !== "spotify" && kind !== "soundcloud") {
      return { ok: false, error: "invalid_source_kind" };
    }

    const fallbackTitle = kind === "upload" ? "Uploaded track" : "Shared source";
    const title = normalizeSourceTitle(input?.title, fallbackTitle);
    const mimeType = normalizeMimeType(input?.mimeType) || null;

    if (kind === "upload") {
      const uploadPath = normalizeUploadUrlPath(input?.url);
      const mediaId = extractMediaIdFromPath(uploadPath);
      if (!uploadPath || !mediaId || !mediaLookup.has(mediaId)) {
        return { ok: false, error: "invalid_upload_source" };
      }
      const media = mediaLookup.get(mediaId)!;
      return {
        ok: true,
        source: {
          kind,
          title,
          url: uploadPath,
          mimeType: mimeType || media.mimeType || null,
          mediaId,
          setByUserId: identity.userId,
        },
      };
    }

    const url = normalizeAbsoluteHttpUrl(input?.url);
    if (!url) {
      return { ok: false, error: "invalid_source_url" };
    }

    if (kind === "spotify" && !/spotify\.com|open\.spotify\.com/i.test(url)) {
      return { ok: false, error: "spotify_url_required" };
    }

    if (kind === "soundcloud" && !/soundcloud\.com/i.test(url)) {
      return { ok: false, error: "soundcloud_url_required" };
    }

    return {
      ok: true,
      source: {
        kind,
        title,
        url,
        mimeType,
        mediaId: null,
        setByUserId: identity.userId,
      },
    };
  };

  const handleMediaRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    asset: MediaAsset
  ): Promise<void> => {
    try {
      const stat = await fsPromises.stat(asset.filePath);
      if (!stat.isFile()) {
        respondJson(res, 404, { ok: false, error: "media_not_found" });
        return;
      }

      const totalSize = stat.size;
      const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : "";
      const isHead = req.method === "HEAD";

      if (rangeHeader) {
        const parsed = parseRangeHeader(rangeHeader, totalSize);
        if (!parsed) {
          res.writeHead(416, {
            "content-range": `bytes */${totalSize}`,
          });
          res.end();
          return;
        }

        const { start, end } = parsed;
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          "accept-ranges": "bytes",
          "cache-control": "public, max-age=3600",
          "content-type": asset.mimeType,
          "content-length": chunkSize,
          "content-range": `bytes ${start}-${end}/${totalSize}`,
        });

        if (isHead) {
          res.end();
          return;
        }

        fs.createReadStream(asset.filePath, { start, end })
          .on("error", () => {
            if (!res.headersSent) respondJson(res, 500, { ok: false, error: "media_read_failed" });
            else res.destroy();
          })
          .pipe(res);
        return;
      }

      res.writeHead(200, {
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=3600",
        "content-type": asset.mimeType,
        "content-length": totalSize,
      });

      if (isHead) {
        res.end();
        return;
      }

      fs.createReadStream(asset.filePath)
        .on("error", () => {
          if (!res.headersSent) respondJson(res, 500, { ok: false, error: "media_read_failed" });
          else res.destroy();
        })
        .pipe(res);
    } catch {
      respondJson(res, 404, { ok: false, error: "media_not_found" });
    }
  };

  const handleHttpRequest = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    let pathname = "";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      pathname = "";
    }

    if (!pathname.startsWith("/api/silent-disco")) return false;

    const authHeaders = getAuthentikHeaders(req.headers as Record<string, unknown>);
    const identity = buildIdentityFromHeaders(authHeaders);

    if (pathname === "/api/silent-disco/me" && req.method === "GET") {
      if (!identity) {
        respondJson(res, 401, { ok: false, error: "unauthorized" });
        return true;
      }
      respondJson(res, 200, {
        ok: true,
        user: {
          userId: identity.userId,
          username: identity.username,
          displayName: identity.displayName,
          email: identity.email,
        },
      });
      return true;
    }

    if (pathname === "/api/silent-disco/link" && req.method === "POST") {
      if (!identity) {
        respondJson(res, 401, { ok: false, error: "unauthorized" });
        return true;
      }

      parseJsonBody(req, 64_000)
        .then((body) => {
          const roomCode = normalizeRoomCode(body?.roomCode);
          if (!roomCode) {
            respondJson(res, 400, { ok: false, error: "missing_room_code" });
            return;
          }

          const room = rooms.get(roomCode);
          if (!room) {
            respondJson(res, 404, { ok: false, error: "room_not_found" });
            return;
          }

          if (identity.userId !== room.hostUserId) {
            respondJson(res, 403, { ok: false, error: "only_host_can_generate_link" });
            return;
          }

          const role = normalizeRole(body?.role);
          if (role === "host" && identity.userId !== room.hostUserId) {
            respondJson(res, 403, { ok: false, error: "only_host_can_generate_link" });
            return;
          }

          const token = signJoinToken(roomCode, role, room.hostUserId);
          respondJson(res, 200, {
            ok: true,
            roomCode,
            role,
            token,
            expiresInSeconds: SILENT_DISCO_LINK_TTL_SECONDS,
          });
        })
        .catch((err) => {
          respondJson(res, 400, { ok: false, error: "invalid_payload", details: String(err) });
        });
      return true;
    }

    if (pathname === "/api/silent-disco/upload" && req.method === "POST") {
      if (!identity) {
        respondJson(res, 401, { ok: false, error: "unauthorized" });
        return true;
      }

      parseJsonBody(req, SILENT_DISCO_UPLOAD_PAYLOAD_MAX_BYTES)
        .then(async (body) => {
          const base64Payload = parseBase64Payload(body?.contentBase64 ?? body?.dataUrl ?? "");
          if (!base64Payload) {
            respondJson(res, 400, { ok: false, error: "missing_audio_data" });
            return;
          }

          let buffer: Buffer;
          try {
            buffer = Buffer.from(base64Payload, "base64");
          } catch {
            respondJson(res, 400, { ok: false, error: "invalid_audio_data" });
            return;
          }

          if (!buffer.length) {
            respondJson(res, 400, { ok: false, error: "invalid_audio_data" });
            return;
          }

          if (buffer.length > SILENT_DISCO_FILE_MAX_BYTES) {
            respondJson(res, 413, {
              ok: false,
              error: "file_too_large",
              maxBytes: SILENT_DISCO_FILE_MAX_BYTES,
            });
            return;
          }

          const originalName = sanitizeFileName(body?.name ?? body?.fileName ?? "track");
          const extensionFromName = path.extname(originalName).toLowerCase();
          const mimeFromName = extensionToMime[extensionFromName] || "";
          const mimeFromPayload = normalizeMimeType(body?.mimeType);
          const mimeType = mimeToExtension[mimeFromPayload]
            ? mimeFromPayload
            : mimeFromName && mimeToExtension[mimeFromName]
              ? mimeFromName
              : "";

          if (!mimeType) {
            respondJson(res, 400, {
              ok: false,
              error: "unsupported_mime_type",
              supported: Object.keys(mimeToExtension),
            });
            return;
          }

          const extension = extensionFromName && extensionToMime[extensionFromName]
            ? extensionFromName
            : mimeToExtension[mimeType] || ".mp3";

          const mediaId = randomUUID();
          const filePath = path.join(silentDiscoMediaDir, `${mediaId}${extension}`);
          await fsPromises.mkdir(silentDiscoMediaDir, { recursive: true });
          await fsPromises.writeFile(filePath, buffer);

          mediaAssets.set(mediaId, {
            id: mediaId,
            filePath,
            mimeType,
            originalName,
            sizeBytes: buffer.length,
            uploadedByUserId: identity.userId,
            createdAt: Date.now(),
          });

          persistStateSoon();

          respondJson(res, 200, {
            ok: true,
            media: {
              id: mediaId,
              url: `/api/silent-disco/media/${mediaId}`,
              mimeType,
              sizeBytes: buffer.length,
              originalName,
            },
          });
        })
        .catch((err) => {
          const message = String((err as Error)?.message || err || "").toLowerCase();
          if (message.includes("payload_too_large")) {
            respondJson(res, 413, { ok: false, error: "payload_too_large" });
            return;
          }
          respondJson(res, 400, { ok: false, error: "invalid_payload", details: String(err) });
        });
      return true;
    }

    if (pathname.startsWith("/api/silent-disco/media/") && (req.method === "GET" || req.method === "HEAD")) {
      const mediaId = decodeURIComponent(pathname.replace("/api/silent-disco/media/", "")).trim();
      const asset = mediaAssets.get(mediaId);
      if (!asset) {
        respondJson(res, 404, { ok: false, error: "media_not_found" });
        return true;
      }
      void handleMediaRequest(req, res, asset);
      return true;
    }

    respondJson(res, 404, { ok: false, error: "not_found" });
    return true;
  };

  const bindSocketConnection = (io: Server, socket: Socket, authHeaders: AuthHeaders): void => {
    const identity = buildIdentityFromHeaders(authHeaders);

    const requireIdentity = (): Identity | null => {
      if (identity?.userId) return identity;
      socket.emit("silent_disco:error", { error: "unauthorized" });
      return null;
    };

    socket.on("silent_disco:create_room", () => {
      const me = requireIdentity();
      if (!me) return;

      if (rooms.size >= MAX_ROOMS) {
        socket.emit("silent_disco:error", { error: "room_capacity_reached" });
        return;
      }

      const roomCode = getOrCreateRoomCode();
      const room: SilentDiscoRoom = {
        roomCode,
        hostUserId: me.userId,
        hostDisplayName: normalizeDisplayName(me),
        source: null,
        playing: false,
        positionMs: 0,
        updatedAtMs: Date.now(),
        lastTouchedAtMs: Date.now(),
        members: new Map(),
      };
      rooms.set(roomCode, room);
      persistStateSoon();

      joinSocketToRoom(io, socket, room, me);
      socket.emit("silent_disco:room_created", { room: roomSnapshot(room) });
    });

    socket.on("silent_disco:join_room", (payload) => {
      const me = requireIdentity();
      if (!me) return;

      const roomCode = normalizeRoomCode(payload?.roomCode);
      if (!roomCode) {
        socket.emit("silent_disco:error", { error: "missing_room_code" });
        return;
      }

      const room = rooms.get(roomCode);
      if (!room) {
        socket.emit("silent_disco:error", { error: "room_not_found" });
        return;
      }

      const joinToken = String(payload?.token || "").trim();
      if (joinToken) {
        const verified = verifyJoinToken(joinToken, roomCode);
        if (!verified.ok) {
          socket.emit("silent_disco:error", { error: verified.error });
          return;
        }

        if (verified.role === "host") {
          if (!verified.hostUserId || verified.hostUserId !== me.userId) {
            socket.emit("silent_disco:error", { error: "join_token_user_mismatch" });
            return;
          }
          room.hostUserId = me.userId;
          room.hostDisplayName = normalizeDisplayName(me);
          markRoomTouched(room);
          persistStateSoon();
        }
      }

      joinSocketToRoom(io, socket, room, me);
      socket.emit("silent_disco:joined", { room: roomSnapshot(room) });
    });

    socket.on("silent_disco:leave_room", () => {
      removeSocketFromRoom(io, socket);
      socket.emit("silent_disco:left", { ok: true });
    });

    socket.on("silent_disco:request_state", (payload) => {
      const room = resolveRoomForSocket(socket, payload);
      if (!room) {
        socket.emit("silent_disco:error", { error: "room_not_found" });
        return;
      }
      socket.emit("silent_disco:state", { room: roomSnapshot(room) });
    });

    socket.on("silent_disco:set_source", (payload) => {
      const me = requireIdentity();
      if (!me) return;

      const room = resolveRoomForSocket(socket, payload);
      if (!room) {
        socket.emit("silent_disco:error", { error: "room_not_found" });
        return;
      }

      if (!ensureHostOwnership(socket, me, room)) return;

      const parsed = parseSource(payload?.source ?? payload, me, mediaAssets);
      if (!parsed.ok) {
        socket.emit("silent_disco:error", { error: parsed.error });
        return;
      }

      room.source = parsed.source;
      room.playing = false;
      room.positionMs = 0;
      room.updatedAtMs = Date.now();
      markRoomTouched(room);

      emitRoomState(io, room);
      persistStateSoon();
    });

    socket.on("silent_disco:play", (payload) => {
      const me = requireIdentity();
      if (!me) return;

      const room = resolveRoomForSocket(socket, payload);
      if (!room) {
        socket.emit("silent_disco:error", { error: "room_not_found" });
        return;
      }

      if (!ensureHostOwnership(socket, me, room)) return;
      if (!room.source) {
        socket.emit("silent_disco:error", { error: "source_missing" });
        return;
      }

      room.positionMs = clampPositionMs(payload?.positionMs ?? estimateCurrentPositionMs(room));
      room.playing = true;
      room.updatedAtMs = Date.now();
      markRoomTouched(room);

      emitRoomState(io, room);
      persistStateSoon();
    });

    socket.on("silent_disco:pause", (payload) => {
      const me = requireIdentity();
      if (!me) return;

      const room = resolveRoomForSocket(socket, payload);
      if (!room) {
        socket.emit("silent_disco:error", { error: "room_not_found" });
        return;
      }

      if (!ensureHostOwnership(socket, me, room)) return;

      room.positionMs = clampPositionMs(payload?.positionMs ?? estimateCurrentPositionMs(room));
      room.playing = false;
      room.updatedAtMs = Date.now();
      markRoomTouched(room);

      emitRoomState(io, room);
      persistStateSoon();
    });

    socket.on("silent_disco:seek", (payload) => {
      const me = requireIdentity();
      if (!me) return;

      const room = resolveRoomForSocket(socket, payload);
      if (!room) {
        socket.emit("silent_disco:error", { error: "room_not_found" });
        return;
      }

      if (!ensureHostOwnership(socket, me, room)) return;

      room.positionMs = clampPositionMs(payload?.positionMs);
      room.updatedAtMs = Date.now();
      markRoomTouched(room);

      emitRoomState(io, room);
      persistStateSoon();
    });

    socket.on("disconnect", () => {
      removeSocketFromRoom(io, socket);
    });
  };

  hydratePersistedState();
  void cleanupStaleData(true);
  startCleanupLoop();

  return {
    handleHttpRequest,
    bindSocketConnection,
  };
};
