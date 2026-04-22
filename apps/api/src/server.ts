import "dotenv/config";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import sharp from "sharp";
import nodemailer from "nodemailer";
import { ClientEventSchema } from "../../../packages/shared/schemas";
import { MatchOrchestrator } from "../../../packages/game-engine/orchestrator";
import type { ClientEvent, LedgerEntry, Match, MatchMode, MatchPlayer, MatchStatus, Stage } from "../../../packages/shared/events";
import {
  loadEventsAfterSeq,
  loadRedisState,
  loadSnapshotFromDb,
  safeDb,
  safeDbValue,
  safeRedisValue,
  upsertMatchRow,
  updateMatchStatus,
  type PersistedMatchState,
} from "./persistence";
import {
  persistClientEvent,
  persistServerEvent,
  saveSnapshotNow,
  saveRedisOnly,
} from "./persist";
import pool from "./db/pool";
import { getRedis } from "./db/redis";
import { computeBirthChart, type ProfileRow } from "./astro";
import { computeProfileInsights } from "./insights";
import { drawDailyTarotCard, getTarotCardByNumber, getTarotMajorArcana } from "./tarot";
import { createSilentDiscoManager } from "./silentDisco";

type MatchRuntime = {
  orchestrator: MatchOrchestrator;
  ready: Set<string>;
  ledger: LedgerEntry[];
  yatzySubmissions: Map<string, number>;
  yatzyMatchId: string | null;
  hostUserId: string;
  hostAuthHeaders: Record<string, string>;
  yatzyAuthToken: string | null;
  blackjack: BlackjackState | null;
  seq: number;
};

const matches = new Map<string, MatchRuntime>();

type BjSideBetChoice = "UNDER" | "OVER";
type BjHandStatus = "ACTIVE" | "STAND" | "BUST" | "BLACKJACK" | "DONE";
type BjHandResult = "WIN" | "LOSE" | "PUSH" | "BLACKJACK";
type BjRoundStatus = "BETTING" | "PLAYER_ACTION" | "DEALER_ACTION" | "RESOLVED";

type BjCard = {
  rank: string;
  suit: string;
};

type BjHand = {
  spot: number;
  cards: BjCard[];
  bet: number;
  status: BjHandStatus;
  isSplit: boolean;
  fromSplitAces: boolean;
  sideBet: BjSideBetChoice | null;
  sideResult?: "WIN" | "LOSE" | "PUSH";
  result?: BjHandResult;
};

type BjPlayerState = {
  userId: string;
  hands: BjHand[];
  placedBet: boolean;
  committed: number;
};

type BjRoundState = {
  round: number;
  status: BjRoundStatus;
  deck: BjCard[];
  dealer: BjHand;
  players: Record<string, BjPlayerState>;
};

type BlackjackState = {
  round: number;
  roundsTotal: number;
  status: "IN_PROGRESS" | "DONE";
  roundState: BjRoundState | null;
};

const BJ_MIN_BET = 10;
const BJ_MAX_BET = 100;
const BJ_MAX_SPOTS = 7;
const BJ_ROUNDS = 10;
const BJ_SIDE_BET_PAYOUT = 1;
const BJ_BLACKJACK_PAYOUT = 1;

const bjRanks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
const bjSuits = ["S", "H", "D", "C"] as const;

const buildDeck = (): BjCard[] => {
  const deck: BjCard[] = [];
  for (const suit of bjSuits) {
    for (const rank of bjRanks) {
      deck.push({ rank, suit });
    }
  }
  return deck;
};

const shuffleDeck = (deck: BjCard[]) => {
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = deck[i];
    deck[i] = deck[j];
    deck[j] = temp;
  }
};

const drawCard = (deck: BjCard[]): BjCard => {
  if (!deck.length) {
    deck.push(...buildDeck());
    shuffleDeck(deck);
  }
  return deck.pop() as BjCard;
};

const cardValue = (card: BjCard): number => {
  if (card.rank === "A") return 11;
  if (card.rank === "K" || card.rank === "Q" || card.rank === "J") return 10;
  return Number(card.rank);
};

const computeHandValue = (cards: BjCard[]): { total: number; soft: boolean; blackjack: boolean } => {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === "A") aces += 1;
    total += cardValue(card);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  const soft = aces > 0;
  const blackjack = cards.length === 2 && total === 21;
  return { total, soft, blackjack };
};

const shouldDealerHit = (cards: BjCard[]): boolean => {
  const { total } = computeHandValue(cards);
  return total < 17;
};

const makeDealerHand = (): BjHand => ({
  spot: 0,
  cards: [],
  bet: 0,
  status: "ACTIVE",
  isSplit: false,
  fromSplitAces: false,
  sideBet: null,
});

const parseJsonBody = async (req: http.IncomingMessage, maxBytes = 1_000_000): Promise<any> => {
  return new Promise((resolve, reject) => {
    let data = "";
    let receivedBytes = 0;
    let settled = false;

    const safeReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const safeResolve = (value: unknown) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      const chunkText = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      receivedBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (receivedBytes > maxBytes) {
        safeReject(new Error("payload_too_large"));
        return;
      }
      data += chunkText;
    });

    req.on("end", () => {
      if (settled) return;
      if (!data.trim()) return safeResolve(null);
      try {
        safeResolve(JSON.parse(data));
      } catch (err) {
        safeReject(err);
      }
    });

    req.on("error", safeReject);
  });
};

const AVATAR_UPLOAD_MAX_BYTES = 8_000_000;
const AVATAR_UPLOAD_PAYLOAD_MAX_BYTES = 12_000_000;
const REPORT_EMAIL_PAYLOAD_MAX_BYTES = Math.max(
  10_000_000,
  Number(process.env.REPORT_EMAIL_PAYLOAD_MAX_BYTES || 60_000_000)
);
const avatarPublicDir = path.resolve(process.cwd(), "apps/web/public/avatars");
const avatarMimeByExtension: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const AVATAR_OPENAI_TIMEOUT_MS = Math.max(5_000, Number(process.env.OPENAI_AVATAR_TIMEOUT_MS || 45_000));
const AVATAR_OPENAI_MODEL = (process.env.OPENAI_AVATAR_MODEL || "gpt-image-1").trim() || "gpt-image-1";
const AVATAR_GTA_PROMPT_DEFAULT =
  "Create a stylized action-game portrait illustration from this face photo: bold outlines, cel-shaded lighting, dramatic contrast, saturated colors, clean background, shoulders-up framing, expressive but realistic face, premium cover-art vibe.";
const AVATAR_GTA_PROMPT =
  (process.env.OPENAI_AVATAR_GTA_PROMPT || AVATAR_GTA_PROMPT_DEFAULT).trim() || AVATAR_GTA_PROMPT_DEFAULT;

let ensureUserAvatarsTablePromise: Promise<void> | null = null;

const ensureUserAvatarsTable = async (): Promise<void> => {
  if (!ensureUserAvatarsTablePromise) {
    ensureUserAvatarsTablePromise = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS public.user_avatars (
           user_id TEXT PRIMARY KEY,
           avatar_mime_type TEXT NOT NULL,
           avatar_data BYTEA NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`
      );

      const legacy = await pool.query(`SELECT to_regclass('stardom.user_avatars') AS table_name`);
      if (legacy.rows[0]?.table_name) {
        await pool.query(
          `INSERT INTO public.user_avatars (user_id, avatar_mime_type, avatar_data, created_at, updated_at)
           SELECT
             user_id,
             avatar_mime_type,
             avatar_data,
             COALESCE(created_at, NOW()),
             COALESCE(updated_at, NOW())
           FROM stardom.user_avatars
           ON CONFLICT (user_id) DO UPDATE
             SET avatar_mime_type = EXCLUDED.avatar_mime_type,
                 avatar_data = EXCLUDED.avatar_data,
                 updated_at = EXCLUDED.updated_at
           WHERE public.user_avatars.updated_at < EXCLUDED.updated_at`
        );
      }
    })().catch((err) => {
      const msg = String((err as Error)?.message || err).toLowerCase();
      if (msg.includes("permission denied")) {
        ensureUserAvatarsTablePromise = Promise.resolve();
        return;
      }
      ensureUserAvatarsTablePromise = null;
      throw err;
    });
  }
  return ensureUserAvatarsTablePromise;
};

const sanitizeAccountValue = (value: unknown, maxLen: number): string | null => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.length > maxLen ? text.slice(0, maxLen) : text;
};

const sanitizeEmailValue = (value: unknown): string | null => {
  const email = sanitizeAccountValue(value, 320);
  if (!email) return null;
  return isValidEmail(email) ? email : null;
};

type SharedUserRow = {
  id: string;
  provider: string | null;
  external_id: string | null;
  email: string | null;
  username: string | null;
  name: string | null;
  player_code: string | null;
};

const normalizeSharedUserRow = (row: any): SharedUserRow | null => {
  if (!row) return null;
  return {
    id: String(row.id ?? ""),
    provider: row.provider ? String(row.provider) : null,
    external_id: row.external_id ? String(row.external_id) : null,
    email: row.email ? String(row.email) : null,
    username: row.username ? String(row.username) : null,
    name: row.name ? String(row.name) : null,
    player_code: row.player_code ? String(row.player_code) : null,
  };
};

const buildSharedUserSeed = (
  headers: Record<string, string>,
  userInfo?: { username?: string | null; email?: string | null; name?: string | null } | null
) => ({
  provider: "authentik",
  externalId: sanitizeAccountValue(headers["x-authentik-uid"], 128),
  email: sanitizeEmailValue(userInfo?.email ?? headers["x-authentik-email"] ?? null),
  username: sanitizeAccountValue(userInfo?.username ?? headers["x-authentik-username"] ?? null, 128),
  name: sanitizeAccountValue(userInfo?.name ?? headers["x-authentik-name"] ?? null, 128),
});

const loadSharedUserByExternalId = async (externalId: string | null): Promise<SharedUserRow | null> => {
  const cleanExternalId = sanitizeAccountValue(externalId, 128);
  if (!cleanExternalId) return null;
  const result = await pool.query(
    `SELECT id::text, provider, external_id, email, username, name, player_code
     FROM public.users
     WHERE provider = 'authentik' AND external_id = $1
     LIMIT 1`,
    [cleanExternalId]
  );
  return normalizeSharedUserRow(result.rows[0]);
};

const ensureSharedUserRecord = async (
  headers: Record<string, string>,
  userInfo?: { username?: string | null; email?: string | null; name?: string | null } | null
): Promise<SharedUserRow | null> => {
  const seed = buildSharedUserSeed(headers, userInfo);
  if (!seed.externalId) return null;
  const result = await pool.query(
    `INSERT INTO public.users (provider, external_id, email, username, name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, external_id) DO UPDATE
       SET email = COALESCE(NULLIF(public.users.email, ''), EXCLUDED.email),
           username = COALESCE(NULLIF(public.users.username, ''), EXCLUDED.username),
           name = COALESCE(NULLIF(public.users.name, ''), EXCLUDED.name)
     RETURNING id::text, provider, external_id, email, username, name, player_code`,
    [seed.provider, seed.externalId, seed.email, seed.username, seed.name]
  );
  return normalizeSharedUserRow(result.rows[0]);
};

const updateSharedUserProfile = async (
  externalId: string | null,
  patch: { email?: string | null; username?: string | null; name?: string | null }
): Promise<SharedUserRow | null> => {
  const cleanExternalId = sanitizeAccountValue(externalId, 128);
  if (!cleanExternalId) return null;
  const result = await pool.query(
    `UPDATE public.users
     SET email = $2,
         username = $3,
         name = $4
     WHERE provider = 'authentik' AND external_id = $1
     RETURNING id::text, provider, external_id, email, username, name, player_code`,
    [
      cleanExternalId,
      sanitizeEmailValue(patch.email ?? null),
      sanitizeAccountValue(patch.username ?? null, 128),
      sanitizeAccountValue(patch.name ?? null, 128),
    ]
  );
  return normalizeSharedUserRow(result.rows[0]);
};

const avatarLookupCandidates = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.map((value) => sanitizeAccountValue(value, 256)).filter(Boolean) as string[]));

const resolveSharedAvatarCandidates = async (
  userId: string | null,
  username: string | null
): Promise<string[]> => {
  const sharedUser = await loadSharedUserByExternalId(userId);
  return avatarLookupCandidates([
    userId,
    sharedUser?.external_id,
    sharedUser?.username,
    sharedUser?.player_code,
    ...avatarStemCandidates(username ?? ""),
    ...avatarStemCandidates(sharedUser?.username ?? ""),
    ...avatarStemCandidates(sharedUser?.name ?? ""),
    ...avatarStemCandidates(sharedUser?.player_code ?? ""),
  ]);
};

const parseImageDataUrl = (value: string): { mimeType: string; buffer: Buffer } | null => {
  const match = String(value || "")
    .trim()
    .match(/^data:(image\/(?:png|jpe?g|webp));base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) return null;
  const mimeType = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
  try {
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length) return null;
    return { mimeType, buffer };
  } catch {
    return null;
  }
};

const toByteaBuffer = (value: unknown): Buffer | null => {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") {
    if (value.startsWith("\\x")) {
      try {
        return Buffer.from(value.slice(2), "hex");
      } catch {
        return null;
      }
    }
    try {
      return Buffer.from(value, "base64");
    } catch {
      return null;
    }
  }
  return null;
};

const avatarStemCandidates = (username: string): string[] => {
  const stem = path.basename(String(username || "").trim()).replace(/\.[a-z0-9]+$/i, "");
  if (!stem) return [];
  const titleCase = `${stem.charAt(0).toUpperCase()}${stem.slice(1)}`;
  return Array.from(new Set([stem, stem.toLowerCase(), titleCase]));
};

const loadAvatarFromDbCandidates = async (
  candidates: string[]
): Promise<{ mimeType: string; buffer: Buffer } | null> => {
  if (!candidates.length) return null;
  await ensureUserAvatarsTable();
  const avatarResult = await pool.query(
    `SELECT user_id, avatar_mime_type, avatar_data
     FROM public.user_avatars
     WHERE user_id = ANY($1::text[])
     ORDER BY array_position($1::text[], user_id)
     LIMIT 1`,
    [candidates]
  );
  if (!avatarResult.rowCount || !avatarResult.rows[0]?.avatar_data) return null;
  const row = avatarResult.rows[0];
  const buffer = toByteaBuffer(row.avatar_data);
  if (!buffer || !buffer.length) return null;
  return {
    mimeType: String(row.avatar_mime_type || "image/jpeg"),
    buffer,
  };
};

const readAvatarFile = async (filePath: string): Promise<{ buffer: Buffer; mimeType: string } | null> => {
  try {
    const buffer = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = avatarMimeByExtension[ext] ?? "application/octet-stream";
    return { buffer, mimeType };
  } catch {
    return null;
  }
};

const loadAvatarFallbackForUsername = async (username: string | null): Promise<{ buffer: Buffer; mimeType: string } | null> => {
  if (!username) return null;
  const stems = avatarStemCandidates(username);
  if (!stems.length) return null;
  const extensions = [".jpg", ".jpeg", ".png", ".webp"];
  for (const stem of stems) {
    for (const ext of extensions) {
      const filePath = path.join(avatarPublicDir, `${stem}${ext}`);
      const avatar = await readAvatarFile(filePath);
      if (avatar) return avatar;
    }
  }
  return null;
};

const loadDefaultAvatarFallback = async (): Promise<{ buffer: Buffer; mimeType: string } | null> => {
  const candidates = ["Default.jpg", "default.jpg", "Default.png", "default.png"];
  for (const name of candidates) {
    const avatar = await readAvatarFile(path.join(avatarPublicDir, name));
    if (avatar) return avatar;
  }
  return null;
};

const styleLooksLikeGta = (style: string): boolean => {
  const v = String(style || "").trim().toLowerCase();
  return v === "gta" || v === "gta5" || v === "gta-5" || v === "gtav" || v === "gta_v";
};

const stylizeAvatarGtaLocal = async (sourceBuffer: Buffer): Promise<Buffer> => {
  const vivid = await sharp(sourceBuffer, { failOn: "none" })
    .rotate()
    .resize(1024, 1024, { fit: "cover", position: "attention" })
    .modulate({ saturation: 1.3, brightness: 1.06 })
    .linear(1.08, -10)
    .sharpen({ sigma: 1.25, m1: 1.2, m2: 2.2, x1: 2, y2: 10, y3: 20 })
    .png()
    .toBuffer();

  const edges = await sharp(vivid)
    .grayscale()
    .convolve({
      width: 3,
      height: 3,
      kernel: [
        -1, -1, -1,
        -1, 8, -1,
        -1, -1, -1,
      ],
    })
    .normalize()
    .threshold(138)
    .negate()
    .toBuffer();

  const lineLayer = await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: { r: 28, g: 22, b: 20, alpha: 0.2 },
    },
  })
    .composite([{ input: edges, blend: "dest-in" }])
    .png()
    .toBuffer();

  return sharp(vivid)
    .composite([{ input: lineLayer, blend: "multiply" }])
    .modulate({ saturation: 1.15 })
    .png()
    .toBuffer();
};

const stylizeAvatarGtaWithOpenAi = async (sourceBuffer: Buffer): Promise<Buffer | null> => {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return null;
  const form = new FormData();
  form.append("model", AVATAR_OPENAI_MODEL);
  form.append("prompt", AVATAR_GTA_PROMPT);
  form.append("size", "1024x1024");
  form.append("image", new Blob([sourceBuffer], { type: "image/png" }), "avatar-source.png");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AVATAR_OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      console.warn("[avatar] openai_edit_failed", response.status, details.slice(0, 500));
      return null;
    }
    const data = await response.json().catch(() => null);
    const first = Array.isArray((data as any)?.data) ? (data as any).data[0] : null;
    const b64 = typeof first?.b64_json === "string" ? first.b64_json.trim() : "";
    if (b64) {
      try {
        return Buffer.from(b64, "base64");
      } catch {
        return null;
      }
    }
    const url = typeof first?.url === "string" ? first.url.trim() : "";
    if (url) {
      const imageResponse = await fetch(url, { signal: controller.signal });
      if (!imageResponse.ok) return null;
      const buffer = Buffer.from(await imageResponse.arrayBuffer());
      return buffer.length ? buffer : null;
    }
    return null;
  } catch (err) {
    console.warn("[avatar] openai_edit_exception", String(err));
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const stylizeAvatarGta = async (sourceBuffer: Buffer): Promise<Buffer> => {
  const viaAi = await stylizeAvatarGtaWithOpenAi(sourceBuffer);
  if (viaAi) return viaAi;
  return stylizeAvatarGtaLocal(sourceBuffer);
};

const toDateString = (value: unknown): string => {
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.includes("T") ? raw.split("T")[0] : raw;
};

const toDateStringWithTz = (value: unknown, tzName: string | null): string => {
  if (!tzName) return toDateString(value);
  if (value instanceof Date && tzSupport?.findTimeZone && tzSupport?.getZonedTime) {
    try {
      const zone = tzSupport.findTimeZone(tzName);
      const zoned = tzSupport.getZonedTime(value, zone);
      if (zoned?.year && zoned?.month && zoned?.day) {
        return `${zoned.year}-${String(zoned.month).padStart(2, "0")}-${String(zoned.day).padStart(2, "0")}`;
      }
    } catch {
      return toDateString(value);
    }
  }
  return toDateString(value);
};

const tzSupport = (() => {
  try {
    const req = createRequire(import.meta.url);
    return req("timezone-support");
  } catch {
    return null;
  }
})();

const calcTzOffsetMinutes = (
  tzName: string | null,
  birthDate: string,
  birthTime: string | null,
  unknownTime: boolean
): number | null => {
  if (!tzName || !birthDate) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null;
  const timeStr = unknownTime ? "12:00:00" : birthTime || "12:00:00";
  const [y, m, d] = birthDate.split("-").map((v) => Number(v));
  const [hh, mm, ss] = timeStr.split(":").map((v) => Number(v));
  if (!y || !m || !d) return null;
  if (tzSupport?.findTimeZone && tzSupport?.getUnixTime) {
    try {
      const zone = tzSupport.findTimeZone(tzName);
      const local = { year: y, month: m, day: d, hours: hh || 0, minutes: mm || 0, seconds: ss || 0 };
      const utcMs = tzSupport.getUnixTime(local, zone);
      const assumedUtcMs = Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0);
      return Math.round((assumedUtcMs - utcMs) / 60000);
    } catch {
      // fallthrough
    }
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tzName,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = fmt.formatToParts(new Date(Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0)));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const inputUtc = Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0);
    return Math.round((asUtc - inputUtc) / 60000);
  } catch {
    return null;
  }
};

const getUserIdFromReq = (req: http.IncomingMessage): string | null => {
  const headers = getAuthentikHeaders(req.headers as Record<string, unknown>);
  return headers["x-authentik-uid"] ?? null;
};

const getDatePartsInTimezone = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
};

const getTarotDateKey = (date: Date, timeZone: string): string => {
  const p = getDatePartsInTimezone(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

const getTarotExpiresAt = (now: Date, timeZone: string): Date => {
  if (tzSupport?.findTimeZone && tzSupport?.getUnixTime) {
    try {
      const zone = tzSupport.findTimeZone(timeZone);
      const zoned = getDatePartsInTimezone(now, timeZone);
      const base = new Date(Date.UTC(zoned.year, zoned.month - 1, zoned.day));
      const shouldUseNextDay = zoned.hour > 0 || (zoned.hour === 0 && zoned.minute >= 1);
      if (shouldUseNextDay) base.setUTCDate(base.getUTCDate() + 1);
      const localReset = {
        year: base.getUTCFullYear(),
        month: base.getUTCMonth() + 1,
        day: base.getUTCDate(),
        hours: 0,
        minutes: 1,
        seconds: 0,
      };
      const utcMs = tzSupport.getUnixTime(localReset, zone);
      return new Date(utcMs);
    } catch {
      // fall through to UTC fallback
    }
  }
  const next = new Date(now);
  next.setUTCHours(0, 1, 0, 0);
  if (now >= next) next.setUTCDate(next.getUTCDate() + 1);
  return next;
};

const getRequestLocale = (req: http.IncomingMessage): string => {
  try {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    const queryLocale = String(requestUrl.searchParams.get("lang") || "").trim();
    if (queryLocale) return queryLocale;
    const explicitHeader = String(req.headers["x-stardom-locale"] || "").trim();
    if (explicitHeader) return explicitHeader;
    const acceptLanguage = String(req.headers["accept-language"] || "").trim();
    if (acceptLanguage) {
      const preferred = acceptLanguage
        .split(",")
        .map((part) => part.split(";")[0]?.trim())
        .find(Boolean);
      if (preferred) return preferred;
    }
    return "en-US";
  } catch {
    return "en-US";
  }
};

const localeText = (locale: string, sv: string, en: string): string =>
  locale.toLowerCase().startsWith("sv") ? sv : en;

const apiErrorMessage = (code: string, locale: string): string => {
  switch (code) {
    case "unauthorized":
      return localeText(locale, "Inloggning krävs.", "Authentication required.");
    case "membership_required":
      return localeText(locale, "Aktivt medlemskap krävs för den här AI-funktionen.", "Active membership required for this AI feature.");
    case "friendship_required":
      return localeText(locale, "Ni behöver vara vänner för att se den här profilen.", "You need to be friends to view this profile.");
    case "membership_code_invalid":
      return localeText(locale, "Registreringskoden är ogiltig eller förbrukad.", "The registration code is invalid or exhausted.");
    case "profile_required":
      return localeText(locale, "Båda behöver ha sparat profil för att matchningen ska fungera.", "Both users need saved profiles for compatibility.");
    case "missing_message":
      return localeText(locale, "Meddelande saknas.", "Missing message.");
    case "oracle_failed":
      return localeText(locale, "Oracle-förfrågan misslyckades.", "Oracle request failed.");
    case "tarot_daily_failed":
      return localeText(locale, "Kunde inte hämta dagens tarotkort.", "Could not load daily tarot card.");
    default:
      return localeText(locale, "Ett fel uppstod.", "An error occurred.");
  }
};

const localizeTarotDailyDrawRow = (row: any, locale: string) => {
  const cardNumber = Number(row?.card_number);
  if (!Number.isFinite(cardNumber)) return row;
  const card = getTarotCardByNumber(cardNumber, locale);
  if (!card) return row;
  return {
    ...row,
    card_name: card.name,
    summary: card.summary,
    upright_meaning: card.upright,
    reversed_meaning: card.reversed,
  };
};

const fetchAuthentikUserInfo = async (headers: Record<string, string>) => {
  const token = headers["x-authentik-jwt"];
  const base = (process.env.AUTHENTIK_URL || "").trim();
  const userInfoUrl = (process.env.AUTHENTIK_USERINFO_URL || "").trim();
  const url = userInfoUrl || (base ? `${base.replace(/\/$/, "")}/application/o/userinfo/` : "");
  if (!token || !url) return null;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data) return null;
    return {
      username: data.preferred_username ?? data.username ?? null,
      email: data.email ?? null,
      name: data.name ?? data.given_name ?? null,
    };
  } catch {
    return null;
  }
};

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const normalizeRecipientEmail = (value: unknown): string => String(value ?? "").trim();

const isValidEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const normalizeAbsoluteUrl = (value: unknown): string => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).toString();
  } catch {
    return "";
  }
};

const formatReportDate = (value: unknown, locale: string): string => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return raw;
  try {
    return new Intl.DateTimeFormat(locale || "en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
};

const formatOrbValue = (value: unknown): string => {
  const orb = Number(value);
  return Number.isFinite(orb) ? orb.toFixed(1) : "—";
};

let mailTransportPromise: Promise<nodemailer.Transporter> | null = null;

const getFirstEnv = (...keys: string[]): string => {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
};

const parseEnvBool = (...keys: string[]): boolean => /^(1|true|yes|on)$/i.test(getFirstEnv(...keys));

const normalizeMailPassword = (host: string, value: unknown): string => {
  const raw = String(value || "");
  const trimmed = raw.trim();
  // Google app passwords are often copied as 4 groups with spaces.
  if (/gmail\.com/i.test(host) && /^[a-z0-9]{4}( [a-z0-9]{4}){3}$/i.test(trimmed)) {
    return trimmed.replace(/\s+/g, "");
  }
  return trimmed;
};

const getMailErrorCode = (error: unknown): string => {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return String((error as { code?: unknown }).code || "").trim().toUpperCase();
};

const getMailErrorResponse = (error: unknown): string => {
  if (!error || typeof error !== "object" || !("response" in error)) return "";
  return String((error as { response?: unknown }).response || "").trim();
};

const getMailErrorMeta = (error: unknown) => {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
  const code = getMailErrorCode(error);
  const response = getMailErrorResponse(error);
  const combined = `${message}\n${response}`;
  const notConfigured = combined.includes("mail_not_configured");
  const authFailed =
    code === "EAUTH" || /badcredentials|username and password not accepted|authentication failed/i.test(combined);
  return { message, code, response, notConfigured, authFailed };
};

const getReportEmailErrorPayload = (error: unknown, locale: string) => {
  const meta = getMailErrorMeta(error);
  if (meta.notConfigured) {
    return {
      status: 503,
      error: "mail_not_configured",
      message: localeText(
        locale,
        "E-post är inte konfigurerat i backend ännu.",
        "Email is not configured in the backend yet."
      ),
      details: meta.message,
    };
  }
  if (meta.authFailed) {
    return {
      status: 503,
      error: "mail_auth_failed",
      message: localeText(
        locale,
        "Backendens e-postinloggning misslyckades. MAIL_USERNAME eller MAIL_PASSWORD behöver rättas.",
        "The backend email login failed. MAIL_USERNAME or MAIL_PASSWORD needs to be fixed."
      ),
      details: meta.response || meta.message,
    };
  }
  return {
    status: 500,
    error: "mail_send_failed",
    message: localeText(
      locale,
      "Kunde inte skicka HTML-e-post just nu.",
      "Could not send the HTML email right now."
    ),
    details: meta.response || meta.message,
  };
};

const getMailTransport = async (): Promise<nodemailer.Transporter> => {
  const host = getFirstEnv("AUTHENTIK_EMAIL__HOST", "MAIL_HOST");
  const port = Number(getFirstEnv("AUTHENTIK_EMAIL__PORT", "MAIL_PORT") || 0);
  const user = getFirstEnv("AUTHENTIK_EMAIL__USERNAME", "MAIL_USERNAME");
  const pass = normalizeMailPassword(host, getFirstEnv("AUTHENTIK_EMAIL__PASSWORD", "MAIL_PASSWORD"));
  const secure =
    parseEnvBool("AUTHENTIK_EMAIL__USE_SSL") ||
    /^(ssl|smtps)$/i.test(getFirstEnv("MAIL_ENCRYPTION")) ||
    port === 465;
  const requireTLS =
    !secure &&
    (parseEnvBool("AUTHENTIK_EMAIL__USE_TLS") || /^(tls|starttls)$/i.test(getFirstEnv("MAIL_ENCRYPTION")));
  if (!host || !Number.isFinite(port) || port <= 0 || !user || !pass) {
    throw new Error("mail_not_configured");
  }
  if (!mailTransportPromise) {
    mailTransportPromise = (async () => {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        requireTLS,
        auth: { user, pass },
      });
      await transporter.verify();
      return transporter;
    })().catch((error) => {
      mailTransportPromise = null;
      throw error;
    });
  }
  return mailTransportPromise;
};

const getMailSender = () => {
  const address = getFirstEnv("AUTHENTIK_EMAIL__FROM", "MAIL_FROM_ADDRESS", "AUTHENTIK_EMAIL__USERNAME", "MAIL_USERNAME");
  const name = String(process.env.MAIL_FROM_NAME || "STARDOM").trim() || "STARDOM";
  if (!address) throw new Error("mail_not_configured");
  return { address, name };
};

const normalizeReportEmailHtml = (value: unknown): string => {
  const html = String(value || "").trim();
  if (!html) return "";
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/\snonce="[^"]*"/gi, "")
    .trim();
};

const normalizeReportEmailFilename = (value: unknown): string => {
  const raw = String(value || "").trim().replace(/[\\/:*?"<>|]+/g, "-");
  const normalized = raw.replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) return "full_natalanalysrapport.html";
  return normalized.toLowerCase().endsWith(".html") ? normalized : `${normalized}.html`;
};

const buildNatalReportEmail = ({
  data,
  reportUrl,
  reportPrintUrl,
  locale,
}: {
  data: any;
  reportUrl: string;
  reportPrintUrl: string;
  locale: string;
}) => {
  const safeLocale = String(locale || "en-US").trim() || "en-US";
  const userName = String(data?.user?.name || data?.user?.username || "STARDOM Member").trim() || "STARDOM Member";
  const generatedAt = formatReportDate(data?.generatedAt, safeLocale);
  const birthDate = String(data?.user?.birthDate || "").trim();
  const birthTime = String(data?.user?.birthTime || "").trim();
  const birthPlace = String(data?.user?.birthPlace || "").trim();
  const rawAvatarUrl = String(data?.user?.avatarUrl || "").trim();
  const avatarUrl = rawAvatarUrl.startsWith("data:") ? rawAvatarUrl : normalizeAbsoluteUrl(rawAvatarUrl);
  const astrology = data?.astrology ?? {};
  const humanDesign = data?.humanDesign ?? {};
  const chineseZodiac = data?.chineseZodiac ?? {};
  const isSwedish = /^sv(?:-|$)/i.test(safeLocale);
  const signSv: Record<string, string> = {
    Aries: "Väduren",
    Taurus: "Oxen",
    Gemini: "Tvillingarna",
    Cancer: "Kräftan",
    Leo: "Lejonet",
    Virgo: "Jungfrun",
    Libra: "Vågen",
    Scorpio: "Skorpionen",
    Sagittarius: "Skytten",
    Capricorn: "Stenbocken",
    Aquarius: "Vattumannen",
    Pisces: "Fiskarna",
  };
  const zodiacAnimalSv: Record<string, string> = {
    Rat: "Råttan",
    Ox: "Oxen",
    Tiger: "Tigern",
    Rabbit: "Kaninen",
    Dragon: "Draken",
    Snake: "Ormen",
    Horse: "Hästen",
    Goat: "Geten",
    Monkey: "Apan",
    Rooster: "Tuppen",
    Dog: "Hunden",
    Pig: "Grisen",
  };
  const localizeSign = (value: unknown): string => {
    const raw = String(value || "").trim();
    if (!raw) return "—";
    return isSwedish ? signSv[raw] || raw : raw;
  };
  const localizeZodiacAnimal = (value: unknown): string => {
    const raw = String(value || "").trim();
    if (!raw) return "—";
    return isSwedish ? zodiacAnimalSv[raw] || raw : raw;
  };
  const shortBirthPlace = (() => {
    if (!birthPlace) return "";
    const parts = birthPlace
      .split(",")
      .map((part: string) => part.trim())
      .filter(Boolean);
    if (parts.length <= 1) return birthPlace;
    const first = parts[0];
    let last = parts[parts.length - 1];
    while (parts.length > 1 && /^\d[\d\s-]*$/.test(last)) {
      parts.pop();
      last = parts[parts.length - 1] || "";
    }
    return last && first.toLowerCase() !== last.toLowerCase() ? `${first}, ${last}` : first;
  })();

  const sunDisplay = localizeSign(astrology?.sun);
  const moonDisplay = localizeSign(astrology?.moon);
  const ascDisplay = localizeSign(astrology?.ascendant);
  const hdType = String(humanDesign?.role || humanDesign?.type || "").trim() || "—";
  const hdAuthority = String(humanDesign?.authority || "").trim() || "—";
  const zodiacAnimalDisplay = localizeZodiacAnimal(chineseZodiac?.animal);
  const birthLine = [birthDate, birthTime, shortBirthPlace].filter(Boolean).join(" · ") || "—";
  const coreSignature = [sunDisplay, hdType, zodiacAnimalDisplay].filter((value) => value && value !== "—").join(" · ") || "—";

  const intro = localeText(
    safeLocale,
    "En metodisk sammanställning baserad på Astrologi, Human Design och den Kinesiska Zodiaken.",
    "A methodical summary based on Astrology, Human Design, and the Chinese Zodiac."
  );
  const dedication = localeText(
    safeLocale,
    `Tillägnad ${userName} som en guide i livet.`,
    `Dedicated to ${userName} as a guide in life.`
  );
  const coreSubtitle = localeText(
    safeLocale,
    "Tre nycklar som formar hur du känner, väljer och blir upplevd.",
    "Three keys that shape how you feel, choose, and are perceived."
  );
  const attachmentHint = localeText(
    safeLocale,
    "Fortsättningen finns i den bifogade fulla HTML-rapporten.",
    "The full continuation is in the attached HTML report."
  );
  const subject = localeText(
    safeLocale,
    `Natalanalysrapport för ${userName}`,
    `Natal Analysis Report for ${userName}`
  );

  const heroNarrative = localeText(
    safeLocale,
    `${userName} bär en karta där Sol, Måne och Ascendent tecknar riktningen. Tillsammans med ${zodiacAnimalDisplay.toLowerCase()}ns kreativa känslighet och Human Design-signaturen skapas en personlig kompass för relationer, arbete och livsval.`,
    `${userName} carries a map where Sun, Moon, and Ascendant shape direction. Together with the creative sensitivity of ${zodiacAnimalDisplay.toLowerCase()} and the Human Design signature, it forms a personal compass for relationships, work, and life choices.`
  );
  const coreNarrative = localeText(
    safeLocale,
    `${userName} bär en Sol i ${sunDisplay}, en Måne i ${moonDisplay} och en Ascendent i ${ascDisplay}. Tillsammans ger de en signatur där vilja, känsla och uttryck möts i samma berättelse. Human Design-typen ${hdType} med auktoriteten ${hdAuthority} visar hur beslut blir mest sanna i praktiken. I bakgrunden färgar årsdjuret ${zodiacAnimalDisplay} ditt sociala grundtempo.`,
    `${userName} carries a Sun in ${sunDisplay}, a Moon in ${moonDisplay}, and an Ascendant in ${ascDisplay}. Together they form a signature where will, feeling, and expression meet in one story. Human Design type ${hdType} with authority ${hdAuthority} shows how decisions become most aligned in practice. In the background, the zodiac animal ${zodiacAnimalDisplay} colors your social baseline tempo.`
  );
  const pill = (value: string, tone: "blue" | "violet" | "green" = "blue") => {
    const tones =
      tone === "violet"
        ? { bg: "#4b3568", border: "#7f63a8", text: "#f2eafe" }
        : tone === "green"
          ? { bg: "#2f524a", border: "#5da88f", text: "#e9fff7" }
          : { bg: "#294766", border: "#5c9fd2", text: "#e9f5ff" };
    return `<span style="display:inline-block;padding:2px 9px;border-radius:999px;background:${tones.bg};border:1px solid ${tones.border};color:${tones.text};font-weight:700;line-height:1.45;">${escapeHtml(
      value
    )}</span>`;
  };

  const html = `<!doctype html>
<html lang="${escapeHtml(safeLocale)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4ecdf;color:#241a12;font-family:Georgia,'Times New Roman',serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f4ecdf;">
      <tr>
        <td align="center" style="padding:20px 12px 32px;">
          <table role="presentation" width="680" cellspacing="0" cellpadding="0" style="width:100%;max-width:680px;border-collapse:collapse;">
            <tr>
              <td style="background:linear-gradient(135deg,#1a263b 0%,#15132a 58%,#2c2216 100%);border:1px solid #3d4f72;border-radius:28px;padding:24px 22px;color:#f0e8d9;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                  <tr>
                    <td valign="top" style="padding:0 12px 0 0;">
                      <p style="margin:0 0 10px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#f0c88f;">SPUTNET WORLD</p>
                      <h1 style="margin:0 0 12px;font-size:42px;line-height:1.05;color:#f0e8d9;">${escapeHtml(
                        localeText(safeLocale, "Natalanalysrapport", "Natal Analysis Report")
                      )}</h1>
                      <p style="margin:0 0 10px;font-size:18px;line-height:1.55;color:#f0e8d9;">${escapeHtml(intro)}</p>
                      <p style="margin:0 0 14px;font-size:30px;line-height:1.3;color:#f0e8d9;font-weight:700;">${escapeHtml(dedication)}</p>
                    </td>
                    ${
                      avatarUrl
                        ? `<td valign="top" align="right" style="width:126px;padding:0 0 0 10px;">
                            <img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(
                            localeText(safeLocale, "Profilbild", "Profile image")
                          )}" width="116" style="display:block;width:116px;max-width:116px;height:auto;border-radius:16px;border:1px solid rgba(255,255,255,0.3);" />
                          </td>`
                        : ""
                    }
                  </tr>
                </table>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:10px;">
                  <tr>
                    <td valign="top" style="width:50%;padding:6px;">
                      <div style="background:rgba(12,18,33,0.45);border:1px solid rgba(186,198,225,0.35);border-radius:16px;padding:12px 14px;">
                        <div style="font-size:11px;letter-spacing:0.13em;text-transform:uppercase;color:#d8cdbf;margin-bottom:4px;">${escapeHtml(
                          localeText(safeLocale, "Namn", "Name")
                        )}</div>
                        <div style="font-size:22px;font-weight:700;line-height:1.35;color:#f0e8d9;">${escapeHtml(userName)}</div>
                      </div>
                    </td>
                    <td valign="top" style="width:50%;padding:6px;">
                      <div style="background:rgba(12,18,33,0.45);border:1px solid rgba(186,198,225,0.35);border-radius:16px;padding:12px 14px;">
                        <div style="font-size:11px;letter-spacing:0.13em;text-transform:uppercase;color:#d8cdbf;margin-bottom:4px;">${escapeHtml(
                          localeText(safeLocale, "Födelsedata", "Birth data")
                        )}</div>
                        <div style="font-size:20px;font-weight:700;line-height:1.45;color:#f0e8d9;">${escapeHtml(birthLine)}</div>
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td valign="top" style="width:50%;padding:6px;">
                      <div style="background:rgba(12,18,33,0.45);border:1px solid rgba(186,198,225,0.35);border-radius:16px;padding:12px 14px;">
                        <div style="font-size:11px;letter-spacing:0.13em;text-transform:uppercase;color:#d8cdbf;margin-bottom:4px;">${escapeHtml(
                          localeText(safeLocale, "Kärnsignatur", "Core signature")
                        )}</div>
                        <div style="font-size:20px;font-weight:700;line-height:1.45;color:#f0e8d9;">${escapeHtml(coreSignature)}</div>
                      </div>
                    </td>
                    <td valign="top" style="width:50%;padding:6px;">
                      <div style="background:rgba(12,18,33,0.45);border:1px solid rgba(186,198,225,0.35);border-radius:16px;padding:12px 14px;">
                        <div style="font-size:11px;letter-spacing:0.13em;text-transform:uppercase;color:#d8cdbf;margin-bottom:4px;">${escapeHtml(
                          localeText(safeLocale, "Skapad", "Created")
                        )}</div>
                        <div style="font-size:20px;font-weight:700;line-height:1.45;color:#f0e8d9;">${escapeHtml(generatedAt || "—")}</div>
                      </div>
                    </td>
                  </tr>
                </table>
                <div style="margin-top:12px;background:rgba(10,14,24,0.55);border-left:5px solid #f1b347;border-radius:14px;padding:14px 14px;">
                  <p style="margin:0;font-size:19px;line-height:1.7;color:#f0e8d9;">
                    ${escapeHtml(heroNarrative)}
                  </p>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding-top:16px;">
                <div style="background:linear-gradient(135deg,#102a47 0%,#121330 58%,#2f2517 100%);border:1px solid #3f5a7e;border-radius:24px;padding:20px 20px;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                    <tr>
                      <td valign="top" style="padding-right:10px;">
                        <p style="margin:0;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#b8cde6;">${escapeHtml(
                          localeText(safeLocale, "Kärna", "Core")
                        )}</p>
                        <h2 style="margin:6px 0 0;font-size:36px;line-height:1.1;color:#f0e8d9;">${escapeHtml(
                          localeText(safeLocale, "Din kosmiska grundton", "Your cosmic baseline")
                        )}</h2>
                      </td>
                      <td valign="top" align="right" style="width:245px;">
                        <p style="margin:8px 0 0;font-size:18px;line-height:1.5;color:#f0e8d9;">${escapeHtml(coreSubtitle)}</p>
                      </td>
                    </tr>
                  </table>
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:10px;">
                    <tr>
                      <td valign="top" style="width:33.33%;padding:6px;">
                        <div style="background:rgba(15,17,46,0.66);border:1px solid #f1b347;border-radius:18px;padding:14px 14px;height:100%;">
                          <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#f1d5a0;margin-bottom:6px;">${escapeHtml(
                            localeText(safeLocale, "Solen", "Sun")
                          )}</div>
                          <div style="font-size:28px;font-weight:700;color:#f0e8d9;line-height:1.35;">${escapeHtml(sunDisplay)}</div>
                        </div>
                      </td>
                      <td valign="top" style="width:33.33%;padding:6px;">
                        <div style="background:rgba(15,17,46,0.66);border:1px solid #5da8de;border-radius:18px;padding:14px 14px;height:100%;">
                          <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#bfdff8;margin-bottom:6px;">${escapeHtml(
                            localeText(safeLocale, "Månen", "Moon")
                          )}</div>
                          <div style="font-size:28px;font-weight:700;color:#f0e8d9;line-height:1.35;">${escapeHtml(moonDisplay)}</div>
                        </div>
                      </td>
                      <td valign="top" style="width:33.33%;padding:6px;">
                        <div style="background:rgba(15,17,46,0.66);border:1px solid #69c7aa;border-radius:18px;padding:14px 14px;height:100%;">
                          <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#c8f5e7;margin-bottom:6px;">${escapeHtml(
                            localeText(safeLocale, "Ascendent", "Ascendant")
                          )}</div>
                          <div style="font-size:28px;font-weight:700;color:#f0e8d9;line-height:1.35;">${escapeHtml(ascDisplay)}</div>
                        </div>
                      </td>
                    </tr>
                  </table>
                  <div style="margin-top:10px;background:rgba(12,16,30,0.58);border:1px solid #5ca4d8;border-radius:16px;padding:14px;">
                    <p style="margin:0;font-size:18px;line-height:1.75;color:#f0e8d9;">
                      ${escapeHtml(userName)} bär en ${pill(localeText(safeLocale, "Sol", "Sun"), "blue")} ${pill(sunDisplay, "blue")},
                      en ${pill(localeText(safeLocale, "Måne", "Moon"), "blue")} ${pill(moonDisplay, "blue")}
                      och en ${pill(localeText(safeLocale, "Ascendent", "Ascendant"), "blue")} ${pill(ascDisplay, "blue")}.
                      ${escapeHtml(
                        localeText(
                          safeLocale,
                          "Tillsammans ger de en signatur där vilja, känsla och uttryck möts i samma berättelse.",
                          "Together they form a signature where will, feeling, and expression meet in one story."
                        )
                      )}
                      ${pill(localeText(safeLocale, "Human Design-typen", "Human Design type"), "violet")} ${pill(hdType, "violet")}
                      ${escapeHtml(localeText(safeLocale, "med auktoriteten", "with authority"))} ${pill(hdAuthority, "violet")}
                      ${escapeHtml(
                        localeText(
                          safeLocale,
                          "visar hur beslut blir mest sanna i praktiken. I bakgrunden färgar årsdjuret",
                          "shows how decisions become most aligned in practice. In the background, the zodiac animal"
                        )
                      )}
                      ${pill(zodiacAnimalDisplay, "green")}
                      ${escapeHtml(
                        localeText(
                          safeLocale,
                          "ditt sociala grundtempo.",
                          "colors your social baseline tempo."
                        )
                      )}
                    </p>
                  </div>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding-top:14px;">
                <p style="margin:0;text-align:center;font-size:14px;line-height:1.55;color:#6b5a49;">
                  ${escapeHtml(attachmentHint)}
                  ${
                    reportUrl
                      ? ` <a href="${escapeHtml(reportUrl)}" style="color:#6b5a49;font-weight:700;">${escapeHtml(
                          localeText(safeLocale, "Öppna full rapport online", "Open full report online")
                        )}</a>`
                      : ""
                  }
                  ${
                    reportPrintUrl
                      ? ` · <a href="${escapeHtml(reportPrintUrl)}" style="color:#6b5a49;">${escapeHtml(
                          localeText(safeLocale, "Utskriftsvänlig version", "Print-friendly version")
                        )}</a>`
                      : ""
                  }
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    subject,
    "",
    intro,
    "",
    dedication,
    "",
    `${localeText(safeLocale, "Födelsedata", "Birth data")}: ${birthLine}`,
    `${localeText(safeLocale, "Solen", "Sun")}: ${sunDisplay}`,
    `${localeText(safeLocale, "Månen", "Moon")}: ${moonDisplay}`,
    `${localeText(safeLocale, "Ascendent", "Ascendant")}: ${ascDisplay}`,
    `${localeText(safeLocale, "Human Design", "Human Design")}: ${hdType}`,
    `${localeText(safeLocale, "Auktoritet", "Authority")}: ${hdAuthority}`,
    `${localeText(safeLocale, "Kinesiskt tecken", "Chinese Zodiac")}: ${zodiacAnimalDisplay}`,
    "",
    heroNarrative,
    "",
    coreNarrative,
    "",
    attachmentHint,
    reportUrl ? `${localeText(safeLocale, "Full rapport online", "Full report online")}: ${reportUrl}` : "",
    reportPrintUrl ? `${localeText(safeLocale, "Utskriftsversion", "Print version")}: ${reportPrintUrl}` : "",
    reportUrl ? `${localeText(safeLocale, "Full rapport", "Full report")}: ${reportUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, html, text };
};

const normalizeMembershipCode = (value: unknown): string =>
  String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");

const membershipSeedCodes = String(process.env.MEMBERSHIP_REGISTRATION_CODES || "")
  .split(",")
  .map((code) => normalizeMembershipCode(code))
  .filter(Boolean);

let ensureMembershipTablesPromise: Promise<void> | null = null;

const ensureMembershipTables = async (): Promise<void> => {
  if (!ensureMembershipTablesPromise) {
    ensureMembershipTablesPromise = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS membership_registration_codes (
           code TEXT PRIMARY KEY,
           label TEXT NOT NULL DEFAULT 'Membership code',
           active BOOLEAN NOT NULL DEFAULT TRUE,
           grants_tier TEXT NOT NULL DEFAULT 'member',
           grants_ai BOOLEAN NOT NULL DEFAULT TRUE,
           max_uses INT NULL,
           use_count INT NOT NULL DEFAULT 0,
           expires_at TIMESTAMPTZ NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS user_memberships (
           user_id TEXT PRIMARY KEY,
           username TEXT NULL,
           display_name TEXT NULL,
           email TEXT NULL,
           active BOOLEAN NOT NULL DEFAULT FALSE,
           tier TEXT NOT NULL DEFAULT 'free',
           ai_access BOOLEAN NOT NULL DEFAULT FALSE,
           registration_code TEXT NULL REFERENCES membership_registration_codes(code) ON DELETE SET NULL,
           joined_at TIMESTAMPTZ NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS user_friendships (
           requester_id TEXT NOT NULL REFERENCES user_memberships(user_id) ON DELETE CASCADE,
           addressee_id TEXT NOT NULL REFERENCES user_memberships(user_id) ON DELETE CASCADE,
           status TEXT NOT NULL DEFAULT 'pending',
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           responded_at TIMESTAMPTZ NULL,
           PRIMARY KEY (requester_id, addressee_id)
         )`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_user_memberships_active
         ON user_memberships(active, username)`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_user_friendships_addressee
         ON user_friendships(addressee_id, status, created_at DESC)`
      );
      await pool.query(
        `DO $$
         BEGIN
           IF NOT EXISTS (
             SELECT 1 FROM pg_constraint WHERE conname = 'membership_registration_codes_use_count_chk'
           ) THEN
             ALTER TABLE membership_registration_codes
               ADD CONSTRAINT membership_registration_codes_use_count_chk
               CHECK (use_count >= 0 AND (max_uses IS NULL OR max_uses >= 1));
           END IF;
           IF NOT EXISTS (
             SELECT 1 FROM pg_constraint WHERE conname = 'user_memberships_tier_chk'
           ) THEN
             ALTER TABLE user_memberships
               ADD CONSTRAINT user_memberships_tier_chk
               CHECK (tier IN ('free', 'member', 'premium'));
           END IF;
           IF NOT EXISTS (
             SELECT 1 FROM pg_constraint WHERE conname = 'user_friendships_status_chk'
           ) THEN
             ALTER TABLE user_friendships
               ADD CONSTRAINT user_friendships_status_chk
               CHECK (status IN ('pending', 'accepted', 'declined'));
           END IF;
           IF NOT EXISTS (
             SELECT 1 FROM pg_constraint WHERE conname = 'user_friendships_not_self_chk'
           ) THEN
             ALTER TABLE user_friendships
               ADD CONSTRAINT user_friendships_not_self_chk
               CHECK (requester_id <> addressee_id);
           END IF;
           IF NOT EXISTS (
             SELECT 1 FROM pg_trigger WHERE tgname = 'trg_membership_registration_codes_updated_at'
           ) THEN
             CREATE TRIGGER trg_membership_registration_codes_updated_at
             BEFORE UPDATE ON membership_registration_codes
             FOR EACH ROW EXECUTE FUNCTION chkn_set_updated_at();
           END IF;
           IF NOT EXISTS (
             SELECT 1 FROM pg_trigger WHERE tgname = 'trg_user_memberships_updated_at'
           ) THEN
             CREATE TRIGGER trg_user_memberships_updated_at
             BEFORE UPDATE ON user_memberships
             FOR EACH ROW EXECUTE FUNCTION chkn_set_updated_at();
           END IF;
           IF NOT EXISTS (
             SELECT 1 FROM pg_trigger WHERE tgname = 'trg_user_friendships_updated_at'
           ) THEN
             CREATE TRIGGER trg_user_friendships_updated_at
             BEFORE UPDATE ON user_friendships
             FOR EACH ROW EXECUTE FUNCTION chkn_set_updated_at();
           END IF;
         END $$;`
      );

      if (membershipSeedCodes.length) {
        for (const code of membershipSeedCodes) {
          await pool.query(
            `INSERT INTO membership_registration_codes (code, label, active, grants_tier, grants_ai)
             VALUES ($1, $2, TRUE, 'member', TRUE)
             ON CONFLICT (code) DO NOTHING`,
            [code, "Seeded membership code"]
          );
        }
      }
    })().catch((err) => {
      ensureMembershipTablesPromise = null;
      throw err;
    });
  }
  return ensureMembershipTablesPromise;
};

const getMembershipRow = async (userId: string) => {
  await ensureMembershipTables();
  const result = await pool.query(
    `SELECT user_id, username, display_name, email, active, tier, ai_access, registration_code, joined_at, created_at, updated_at
     FROM user_memberships
     WHERE user_id = $1`,
    [userId]
  );
  return result.rowCount ? result.rows[0] : null;
};

const upsertMembershipIdentity = async (
  userId: string,
  identity: { username?: string | null; displayName?: string | null; email?: string | null }
) => {
  await ensureMembershipTables();
  const username = sanitizeAccountValue(identity.username ?? null, 128);
  const displayName = sanitizeAccountValue(identity.displayName ?? null, 128);
  const email = sanitizeEmailValue(identity.email ?? null);
  await pool.query(
    `INSERT INTO user_memberships (user_id, username, display_name, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id)
     DO UPDATE SET
       username = COALESCE(NULLIF(EXCLUDED.username, ''), user_memberships.username),
       display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), user_memberships.display_name),
       email = COALESCE(NULLIF(EXCLUDED.email, ''), user_memberships.email),
       updated_at = NOW()`,
    [userId, username || null, displayName || null, email || null]
  );
  return getMembershipRow(userId);
};

const membershipHasAiAccess = (membership: any): boolean =>
  Boolean(membership?.active && membership?.ai_access && membership?.tier && membership.tier !== "free");

const syncMembershipIdentity = async (userId: string, headers: Record<string, string>) => {
  const userInfo = await fetchAuthentikUserInfo(headers);
  const sharedUser = await ensureSharedUserRecord(headers, userInfo);
  return upsertMembershipIdentity(userId, {
    username: sharedUser?.username ?? userInfo?.username ?? headers["x-authentik-username"] ?? null,
    displayName: sharedUser?.name ?? userInfo?.name ?? headers["x-authentik-name"] ?? null,
    email: sharedUser?.email ?? userInfo?.email ?? headers["x-authentik-email"] ?? null,
  });
};

const ensureMembershipRecordForUser = async (userId: string | null): Promise<any | null> => {
  const cleanUserId = sanitizeAccountValue(userId, 128);
  if (!cleanUserId) return null;
  const existing = await getMembershipRow(cleanUserId);
  if (existing) return existing;
  const sharedUser = await loadSharedUserByExternalId(cleanUserId);
  if (!sharedUser) return null;
  return upsertMembershipIdentity(cleanUserId, {
    username: sharedUser.username,
    displayName: sharedUser.name,
    email: sharedUser.email,
  });
};

const areAcceptedFriends = async (leftUserId: string, rightUserId: string): Promise<boolean> => {
  if (!leftUserId || !rightUserId) return false;
  if (leftUserId === rightUserId) return true;
  await ensureMembershipTables();
  const result = await pool.query(
    `SELECT 1
     FROM user_friendships
     WHERE status = 'accepted'
       AND (
         (requester_id = $1 AND addressee_id = $2)
         OR
         (requester_id = $2 AND addressee_id = $1)
       )
     LIMIT 1`,
    [leftUserId, rightUserId]
  );
  return Number(result.rowCount || 0) > 0;
};

const canAccessProfilePayload = async (authUserId: string, requestedId: string): Promise<boolean> => {
  if (!authUserId || !requestedId) return false;
  if (authUserId === requestedId) return true;
  return areAcceptedFriends(authUserId, requestedId);
};

const ASTRO_SIGN_ELEMENT: Record<string, string> = {
  Aries: "fire",
  Leo: "fire",
  Sagittarius: "fire",
  Taurus: "earth",
  Virgo: "earth",
  Capricorn: "earth",
  Gemini: "air",
  Libra: "air",
  Aquarius: "air",
  Cancer: "water",
  Scorpio: "water",
  Pisces: "water",
};

const CHINESE_TRINES: Record<string, string> = {
  Rat: "inventors",
  Dragon: "inventors",
  Monkey: "inventors",
  Ox: "builders",
  Snake: "builders",
  Rooster: "builders",
  Tiger: "rebels",
  Horse: "rebels",
  Dog: "rebels",
  Rabbit: "heart",
  Goat: "heart",
  Pig: "heart",
};

const ASTRO_SIGN_SV: Record<string, string> = {
  Aries: "Väduren",
  Taurus: "Oxen",
  Gemini: "Tvillingarna",
  Cancer: "Kräftan",
  Leo: "Lejonet",
  Virgo: "Jungfrun",
  Libra: "Vågen",
  Scorpio: "Skorpionen",
  Sagittarius: "Skytten",
  Capricorn: "Stenbocken",
  Aquarius: "Vattumannen",
  Pisces: "Fiskarna",
};

const CHINESE_ZODIAC_SV: Record<string, string> = {
  Rat: "Råttan",
  Ox: "Oxen",
  Tiger: "Tigern",
  Rabbit: "Kaninen",
  Dragon: "Draken",
  Snake: "Ormen",
  Horse: "Hästen",
  Goat: "Geten",
  Monkey: "Apen",
  Rooster: "Tuppen",
  Dog: "Hunden",
  Pig: "Grisen",
};

const HUMAN_DESIGN_SV: Record<string, string> = {
  Projector: "Projektor",
  Generator: "Generator",
  "Manifesting Generator": "Manifesting Generator",
  Manifestor: "Manifestor",
  Reflector: "Reflektor",
  "Emotional Authority": "Emotionell auktoritet",
  "Sacral Authority": "Sakral auktoritet",
  "Splenic Authority": "Mjältautoritet",
  "Ego Authority": "Ego-auktoritet",
  "Self Projected Authority": "Självprojicerad auktoritet",
  "Mental Authority": "Mental auktoritet",
  "Lunar Authority": "Lunar auktoritet",
  "Wait for the Invitation": "Vänta på inbjudan",
  "Wait to Respond": "Vänta på respons",
  "Inform before acting": "Informera före handling",
  "Wait a Lunar Cycle": "Vänta en måncykel",
  "Single Definition": "Single Definition",
  "Split Definition": "Split Definition",
};

const SIGN_TONE: Record<string, { sv: string; en: string }> = {
  Aries: { sv: "rak, snabb och modig", en: "direct, quick, and brave" },
  Taurus: { sv: "jordnära, stadig och sensuell", en: "grounded, steady, and sensual" },
  Gemini: { sv: "rörlig, nyfiken och snabb i uttrycket", en: "changeable, curious, and quick in expression" },
  Cancer: { sv: "omsorgsfull, känslig och beskyddande", en: "caring, sensitive, and protective" },
  Leo: { sv: "varm, stolt och uttrycksfull", en: "warm, proud, and expressive" },
  Virgo: { sv: "analytisk, omsorgsfull och detaljmedveten", en: "analytical, caring, and detail-aware" },
  Libra: { sv: "social, relationsmedveten och harmonisökande", en: "social, relationship-aware, and harmony-seeking" },
  Scorpio: { sv: "intensiv, djup och kontrollerad", en: "intense, deep, and controlled" },
  Sagittarius: { sv: "öppen, sökande och frihetsälskande", en: "open, seeking, and freedom-loving" },
  Capricorn: { sv: "målmedveten, återhållsam och ansvarstagande", en: "driven, restrained, and responsible" },
  Aquarius: { sv: "fri, originell och självständig", en: "free, original, and independent" },
  Pisces: { sv: "mjuk, intuitiv och genomsläpplig", en: "soft, intuitive, and permeable" },
};

const compareElements = (left?: string | null, right?: string | null): number => {
  const a = ASTRO_SIGN_ELEMENT[String(left || "")] || "";
  const b = ASTRO_SIGN_ELEMENT[String(right || "")] || "";
  if (!a || !b) return 0.58;
  if (a === b) return 0.9;
  if ((a === "fire" && b === "air") || (a === "air" && b === "fire")) return 0.82;
  if ((a === "earth" && b === "water") || (a === "water" && b === "earth")) return 0.8;
  return 0.52;
};

const compareExactOrNear = (left?: string | null, right?: string | null, same = 0.92, near = 0.64): number => {
  const a = String(left || "").trim().toLowerCase();
  const b = String(right || "").trim().toLowerCase();
  if (!a || !b) return 0.58;
  if (a === b) return same;
  const aBits = a.split(/[\s/•-]+/).filter(Boolean);
  const bBits = new Set(b.split(/[\s/•-]+/).filter(Boolean));
  return aBits.some((part) => bBits.has(part)) ? near : 0.5;
};

const compareHumanDesignType = (left?: string | null, right?: string | null): number => {
  const a = String(left || "").trim().toLowerCase();
  const b = String(right || "").trim().toLowerCase();
  if (!a || !b) return 0.6;
  if (a === b) return 0.88;
  if ((a.includes("generator") && b.includes("generator")) || (a.includes("projector") && b.includes("projector"))) {
    return 0.8;
  }
  if (a.includes("reflector") || b.includes("reflector")) return 0.72;
  return 0.62;
};

const compareChineseZodiac = (left?: string | null, right?: string | null): number => {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return 0.6;
  if (a === b) return 0.86;
  const trineA = CHINESE_TRINES[a];
  const trineB = CHINESE_TRINES[b];
  if (trineA && trineA === trineB) return 0.82;
  return 0.55;
};

const averageCompatibility = (...scores: number[]): number => {
  const valid = scores.filter((score) => Number.isFinite(score));
  if (!valid.length) return 0.58;
  return valid.reduce((sum, score) => sum + score, 0) / valid.length;
};

const scoreToPercent = (score: number): number => Math.max(0, Math.min(100, Math.round(score * 100)));

const getPlanetSign = (insightsRow: any, planetName: string): string | null => {
  const summary = insightsRow?.summary_json || {};
  if (planetName === "Sun") return summary?.astrology?.sun ?? null;
  if (planetName === "Moon") return summary?.astrology?.moon ?? null;
  if (planetName === "Ascendant") return summary?.astrology?.ascendant ?? null;
  const planets = Array.isArray(insightsRow?.astrology_json?.planets) ? insightsRow.astrology_json.planets : [];
  const match = planets.find((planet: any) => String(planet?.name || "").trim().toLowerCase() === planetName.toLowerCase());
  return typeof match?.sign === "string" && match.sign.trim() ? match.sign.trim() : null;
};

const compareSignPlacement = (left?: string | null, right?: string | null, same = 0.92, near = 0.68): number =>
  averageCompatibility(compareExactOrNear(left, right, same, near), compareElements(left, right));

const scoreLabel = (score: number, locale: string, high: [string, string], mid: [string, string], low: [string, string]) => {
  if (score >= 80) return localeText(locale, high[0], high[1]);
  if (score >= 63) return localeText(locale, mid[0], mid[1]);
  return localeText(locale, low[0], low[1]);
};

const localizeAstroSign = (sign: string | null | undefined, locale: string): string => {
  const raw = String(sign || "").trim();
  if (!raw) return localeText(locale, "okänd", "unknown");
  return localeText(locale, ASTRO_SIGN_SV[raw] || raw, raw);
};

const localizeChineseAnimal = (animal: string | null | undefined, locale: string): string => {
  const raw = String(animal || "").trim();
  if (!raw) return localeText(locale, "okänt tecken", "unknown sign");
  return localeText(locale, CHINESE_ZODIAC_SV[raw] || raw, raw);
};

const localizeHumanDesignValue = (value: string | null | undefined, locale: string): string => {
  const raw = String(value || "").trim();
  if (!raw) return localeText(locale, "okänd", "unknown");
  return localeText(locale, HUMAN_DESIGN_SV[raw] || raw, raw);
};

const signTone = (sign: string | null | undefined, locale: string): string => {
  const raw = String(sign || "").trim();
  const tone = SIGN_TONE[raw];
  if (!tone) return localeText(locale, "en egen rytm", "its own rhythm");
  return localeText(locale, tone.sv, tone.en);
};

const describePlacement = (planet: string, sign: string | null | undefined, locale: string): string => {
  const signName = localizeAstroSign(sign, locale);
  const tone = signTone(sign, locale);
  switch (planet) {
    case "Sun":
      return localeText(
        locale,
        `Sol i ${signName} färgar identiteten med en energi som känns ${tone}.`,
        `Sun in ${signName} colors identity with an energy that feels ${tone}.`
      );
    case "Moon":
      return localeText(
        locale,
        `Månen i ${signName} bearbetar känslor på ett sätt som känns ${tone}.`,
        `Moon in ${signName} processes feelings in a way that feels ${tone}.`
      );
    case "Ascendant":
      return localeText(
        locale,
        `Ascendent i ${signName} gör första intrycket ${tone}.`,
        `Ascendant in ${signName} makes the first impression feel ${tone}.`
      );
    case "Mercury":
      return localeText(
        locale,
        `Merkurius i ${signName} tänker och talar på ett sätt som känns ${tone}.`,
        `Mercury in ${signName} thinks and speaks in a way that feels ${tone}.`
      );
    case "Venus":
      return localeText(
        locale,
        `Venus i ${signName} visar kärlek och smak genom en stil som känns ${tone}.`,
        `Venus in ${signName} expresses affection and taste through a style that feels ${tone}.`
      );
    case "Mars":
      return localeText(
        locale,
        `Mars i ${signName} tar initiativ och hanterar friktion på ett sätt som känns ${tone}.`,
        `Mars in ${signName} takes initiative and handles friction in a way that feels ${tone}.`
      );
    case "Jupiter":
      return localeText(
        locale,
        `Jupiter i ${signName} söker mening, tro och riktning genom en ton som känns ${tone}.`,
        `Jupiter in ${signName} seeks meaning, faith, and direction through a tone that feels ${tone}.`
      );
    case "Saturn":
      return localeText(
        locale,
        `Saturnus i ${signName} tar ansvar, struktur och plikt på ett sätt som känns ${tone}.`,
        `Saturn in ${signName} approaches responsibility, structure, and duty in a way that feels ${tone}.`
      );
    default:
      return localeText(
        locale,
        `${planet} i ${signName} bär en ton som känns ${tone}.`,
        `${planet} in ${signName} carries a tone that feels ${tone}.`
      );
  }
};

const formatCompatibilityOutOfTen = (overall: number, locale: string, fractionDigits = 1): string => {
  try {
    return new Intl.NumberFormat(localeText(locale, "sv-SE", "en-US"), {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(Math.max(0, Math.min(100, overall)) / 10);
  } catch {
    return (Math.max(0, Math.min(100, overall)) / 10).toFixed(fractionDigits);
  }
};

const computeDeepDiveLovePotential = (
  overall: number,
  scores: Record<string, number>,
  selfSummary: any,
  friendSummary: any
): number => {
  const sameType =
    String(selfSummary?.human_design?.type || "").trim().toLowerCase() ===
    String(friendSummary?.human_design?.type || "").trim().toLowerCase();
  const sameAuthority =
    String(selfSummary?.human_design?.authority || "").trim().toLowerCase() ===
    String(friendSummary?.human_design?.authority || "").trim().toLowerCase();
  const sameStrategy =
    String(selfSummary?.human_design?.strategy || "").trim().toLowerCase() ===
    String(friendSummary?.human_design?.strategy || "").trim().toLowerCase();

  const weighted =
    overall * 0.45 +
    (scores.moods_emotions || 0) * 0.15 +
    (scores.responsibility || 0) * 0.15 +
    (scores.sex_aggression || 0) * 0.15 +
    (scores.intellect_communication || 0) * 0.05 +
    (scores.basic_identities || 0) * 0.05;
  const bonus = (sameType ? 4 : 0) + (sameAuthority ? 4 : 0) + (sameStrategy ? 1 : 0);
  const raw = Math.max(0, Math.min(100, weighted + bonus));
  return Math.floor(raw / 5) * 5;
};

const weakestDimensionAdvice = (key: string, locale: string): string => {
  switch (key) {
    case "basic_identities":
      return localeText(
        locale,
        "Var tydliga tidigt med hur ni vill bli lästa, så att första intrycket inte får styra hela relationen.",
        "Be explicit early about how you want to be read, so first impressions do not steer the whole relationship."
      );
    case "moods_emotions":
      return localeText(
        locale,
        "Låt känslor få landa innan ni reagerar, särskilt när någon av er känner sig missförstådd.",
        "Let feelings settle before reacting, especially when one of you feels misunderstood."
      );
    case "intellect_communication":
      return localeText(
        locale,
        "Dubbelkolla ord, tempo och vad ni faktiskt menar, i stället för att tro att den andra automatiskt fattar.",
        "Double-check words, pacing, and what you actually mean instead of assuming the other person automatically gets it."
      );
    case "love_pleasure":
      return localeText(
        locale,
        "Prata konkret om hur ni vill ge och ta emot närhet, annars blir skillnader i stil lätt personliga.",
        "Talk concretely about how you each want to give and receive closeness, otherwise stylistic differences turn personal quickly."
      );
    case "responsibility":
      return localeText(
        locale,
        "Sätt ord på förväntningar, ansvar och vardagslogistik i stället för att hoppas att det löser sig av sig självt.",
        "Put expectations, responsibility, and daily logistics into words instead of hoping they sort themselves out."
      );
    case "sex_aggression":
      return localeText(
        locale,
        "Var tydliga kring initiativ, gränser och tempo, så att gnista inte glider över i irritation.",
        "Be clear about initiative, boundaries, and pace so chemistry does not slide into irritation."
      );
    case "philosophies_of_life":
      return localeText(
        locale,
        "Ge olika livssyner plats utan att göra dem till ett maktprov, annars blir avståndet större än det behöver vara.",
        "Give different life views room without turning them into a power struggle, otherwise the distance grows larger than it needs to."
      );
    default:
      return localeText(locale, "Var nyfikna på olikheter innan ni försöker lösa dem.", "Stay curious about differences before trying to solve them.");
  }
};

const buildCompatibilityDeepDive = (
  selfInsights: any,
  friendInsights: any,
  locale: string,
  overall: number,
  coreDimensions: Array<{ key: string; label: string; focus: string; score: number; note: string }>,
  weakestDimension: { key: string; label: string; focus: string; score: number; note: string },
  displayNames?: { self?: string | null; friend?: string | null }
) => {
  const selfSummary = selfInsights?.summary_json || {};
  const friendSummary = friendInsights?.summary_json || {};
  const selfName = String(displayNames?.self || "").trim() || localeText(locale, "Du", "You");
  const friendName = String(displayNames?.friend || "").trim() || localeText(locale, "Din vän", "Your friend");
  const selfSun = getPlanetSign(selfInsights, "Sun");
  const selfMoon = getPlanetSign(selfInsights, "Moon");
  const selfAsc = getPlanetSign(selfInsights, "Ascendant");
  const selfMercury = getPlanetSign(selfInsights, "Mercury");
  const selfVenus = getPlanetSign(selfInsights, "Venus");
  const selfMars = getPlanetSign(selfInsights, "Mars");
  const selfJupiter = getPlanetSign(selfInsights, "Jupiter");
  const selfSaturn = getPlanetSign(selfInsights, "Saturn");
  const friendSun = getPlanetSign(friendInsights, "Sun");
  const friendMoon = getPlanetSign(friendInsights, "Moon");
  const friendAsc = getPlanetSign(friendInsights, "Ascendant");
  const friendMercury = getPlanetSign(friendInsights, "Mercury");
  const friendVenus = getPlanetSign(friendInsights, "Venus");
  const friendMars = getPlanetSign(friendInsights, "Mars");
  const friendJupiter = getPlanetSign(friendInsights, "Jupiter");
  const friendSaturn = getPlanetSign(friendInsights, "Saturn");
  const selfHdAuthority = selfSummary?.human_design?.authority ?? null;
  const friendHdAuthority = friendSummary?.human_design?.authority ?? null;
  const selfHdProfile = selfSummary?.human_design?.profile ?? null;
  const friendHdProfile = friendSummary?.human_design?.profile ?? null;
  const selfHdStrategy = selfSummary?.human_design?.strategy ?? null;
  const friendHdStrategy = friendSummary?.human_design?.strategy ?? null;
  const selfHdDefinition = selfInsights?.human_design_json?.definition ?? null;
  const friendHdDefinition = friendInsights?.human_design_json?.definition ?? null;
  const selfChinese = selfSummary?.chinese_zodiac ?? null;
  const friendChinese = friendSummary?.chinese_zodiac ?? null;
  const noteFor = (key: string) => coreDimensions.find((dimension) => dimension.key === key)?.note || "";
  const scoreFor = (key: string) => coreDimensions.find((dimension) => dimension.key === key)?.score || 0;
  const deepDiveLovePotential = computeDeepDiveLovePotential(
    overall,
    {
      basic_identities: scoreFor("basic_identities"),
      moods_emotions: scoreFor("moods_emotions"),
      intellect_communication: scoreFor("intellect_communication"),
      responsibility: scoreFor("responsibility"),
      sex_aggression: scoreFor("sex_aggression"),
    },
    selfSummary,
    friendSummary
  );

  const sections = [
    {
      key: "basic_identities",
      title: localeText(locale, "Kärnenergi och första intryck", "Core energy and first impression"),
      score: scoreFor("basic_identities"),
      summary: noteFor("basic_identities"),
      body: [
        localeText(
          locale,
          `${selfName} har Sol i ${localizeAstroSign(selfSun, locale)}, Måne i ${localizeAstroSign(selfMoon, locale)} och Ascendent i ${localizeAstroSign(selfAsc, locale)}. ${describePlacement("Sun", selfSun, locale)} ${describePlacement("Moon", selfMoon, locale)} ${describePlacement("Ascendant", selfAsc, locale)}`,
          `${selfName} has Sun in ${localizeAstroSign(selfSun, locale)}, Moon in ${localizeAstroSign(selfMoon, locale)}, and Ascendant in ${localizeAstroSign(selfAsc, locale)}. ${describePlacement("Sun", selfSun, locale)} ${describePlacement("Moon", selfMoon, locale)} ${describePlacement("Ascendant", selfAsc, locale)}`
        ),
        localeText(
          locale,
          `${friendName} har Sol i ${localizeAstroSign(friendSun, locale)}, Måne i ${localizeAstroSign(friendMoon, locale)} och Ascendent i ${localizeAstroSign(friendAsc, locale)}. ${describePlacement("Sun", friendSun, locale)} ${describePlacement("Moon", friendMoon, locale)} ${describePlacement("Ascendant", friendAsc, locale)}`,
          `${friendName} has Sun in ${localizeAstroSign(friendSun, locale)}, Moon in ${localizeAstroSign(friendMoon, locale)}, and Ascendant in ${localizeAstroSign(friendAsc, locale)}. ${describePlacement("Sun", friendSun, locale)} ${describePlacement("Moon", friendMoon, locale)} ${describePlacement("Ascendant", friendAsc, locale)}`
        ),
        scoreFor("basic_identities") >= 80
          ? localeText(locale, "Det här brukar skapa snabb igenkänning och en tydlig känsla av att ni ser vem den andra är.", "This usually creates quick recognition and a clear sense of seeing who the other person really is.")
          : scoreFor("basic_identities") >= 63
            ? localeText(locale, "Här finns magnetism genom både träff och olikhet. Det kan bli levande, men kräver att ni lär er läsa varandras stil i stället för att anta för mycket.", "There is magnetism here through both overlap and difference. It can feel vivid, but it asks you to learn each other's style instead of assuming too much.")
            : localeText(locale, "Här ligger en tydlig översättningszon. Om ni låter första intrycket bli hela sanningen missar ni lätt djupet i den andra personen.", "This is a clear translation zone. If first impressions become the whole truth, you easily miss the depth in the other person.")
      ].join("\n\n"),
    },
    {
      key: "moods_emotions",
      title: localeText(locale, "Känslor och emotionellt tempo", "Feelings and emotional pacing"),
      score: scoreFor("moods_emotions"),
      summary: noteFor("moods_emotions"),
      body: [
        `${describePlacement("Moon", selfMoon, locale)} ${describePlacement("Moon", friendMoon, locale)}`,
        selfHdAuthority && friendHdAuthority && selfHdAuthority === friendHdAuthority
          ? localeText(locale, `Båda bär ${localizeHumanDesignValue(selfHdAuthority, locale)} i Human Design. Det kan ge ovanligt mycket känslomässig igenkänning, men också en risk att båda väntar länge innan någon säger tydligt vad som känns.`, `You both carry ${localizeHumanDesignValue(selfHdAuthority, locale)} in Human Design. That can create unusual emotional recognition, but also the risk that both wait a long time before someone clearly says what they feel.`)
          : localeText(locale, `${selfName} bär ${localizeHumanDesignValue(selfHdAuthority, locale)} medan ${friendName} bär ${localizeHumanDesignValue(friendHdAuthority, locale)}. Det gör att trygghet och reglering inte alltid kommer se likadan ut för er.`, `${selfName} carries ${localizeHumanDesignValue(selfHdAuthority, locale)} while ${friendName} carries ${localizeHumanDesignValue(friendHdAuthority, locale)}. That means safety and regulation will not always look the same for the two of you.`),
        scoreFor("moods_emotions") >= 80
          ? localeText(locale, "Det här ser ut som ett område som verkligen kan bära relationen. När ni väl är trygga kan ni bli en plats där den andra får landa.", "This looks like an area that can genuinely carry the relationship. Once safety is there, you can become a place where the other person gets to land.")
          : scoreFor("moods_emotions") >= 63
            ? localeText(locale, "Ni kan möta varandra känslomässigt, men behöver vara tydliga med när ni vill ha mjukhet och när ni vill ha klarhet.", "You can meet each other emotionally, but you need to be clear about when you want softness and when you want clarity.")
            : localeText(locale, "Här blir det lätt missförstånd om ni gissar i stället för att fråga. Känslor behöver språk mellan er, inte bara stämning.", "This area easily breeds misunderstanding if you guess instead of ask. Feelings need language between you, not just atmosphere.")
      ].join("\n\n"),
    },
    {
      key: "intellect_communication",
      title: localeText(locale, "Kommunikation och mental kemi", "Communication and mental chemistry"),
      score: scoreFor("intellect_communication"),
      summary: noteFor("intellect_communication"),
      body: [
        `${describePlacement("Mercury", selfMercury, locale)} ${describePlacement("Mercury", friendMercury, locale)}`,
        selfHdStrategy && friendHdStrategy && selfHdStrategy === friendHdStrategy
          ? localeText(locale, `Ni delar dessutom strategin ${localizeHumanDesignValue(selfHdStrategy, locale)}. Det kan skapa en lättnad i att ni intuitivt förstår varför den andra inte alltid vill rusa först.`, `You also share the strategy ${localizeHumanDesignValue(selfHdStrategy, locale)}. That can create relief in how intuitively you understand why the other person does not always want to rush first.`)
          : localeText(locale, `Ni bär olika strategier i Human Design, ${localizeHumanDesignValue(selfHdStrategy, locale)} respektive ${localizeHumanDesignValue(friendHdStrategy, locale)}. Därför kan ni vilja ha olika vägar in i samma samtal.`, `You carry different Human Design strategies, ${localizeHumanDesignValue(selfHdStrategy, locale)} and ${localizeHumanDesignValue(friendHdStrategy, locale)}. That means you may want different routes into the same conversation.`),
        scoreFor("intellect_communication") >= 80
          ? localeText(locale, "Tankemässigt finns god chans att ni väcker varandras klarhet. Samtal kan bli både levande och utvecklande.", "Mentally, there is a good chance you activate each other's clarity. Conversation can become both lively and developmental.")
          : scoreFor("intellect_communication") >= 63
            ? localeText(locale, "Samtalen kan bli riktigt bra, men ni behöver ibland olika tempo för att känna att ni faktiskt blivit hörda.", "Conversation can become genuinely good, but you sometimes need different pacing to feel truly heard.")
            : localeText(locale, "Här kan orden bli för snabba, för skarpa eller för diffusa. Ni vinner på att spegla tillbaka det ni tror att den andra menar.", "Here, words can become too fast, too sharp, or too vague. You both benefit from reflecting back what you think the other person means.")
      ].join("\n\n"),
    },
    {
      key: "love_pleasure",
      title: localeText(locale, "Kärlek, smak och tillgivenhet", "Love, pleasure, and affection"),
      score: scoreFor("love_pleasure"),
      summary: noteFor("love_pleasure"),
      body: [
        localeText(locale, `${selfName} bär Venus i ${localizeAstroSign(selfVenus, locale)} och ${friendName} bär Venus i ${localizeAstroSign(friendVenus, locale)}. ${describePlacement("Venus", selfVenus, locale)} ${describePlacement("Venus", friendVenus, locale)}`, `${selfName} carries Venus in ${localizeAstroSign(selfVenus, locale)} and ${friendName} carries Venus in ${localizeAstroSign(friendVenus, locale)}. ${describePlacement("Venus", selfVenus, locale)} ${describePlacement("Venus", friendVenus, locale)}`),
        localeText(locale, `Närhet färgas också av Månen. ${describePlacement("Moon", selfMoon, locale)} ${describePlacement("Moon", friendMoon, locale)}`, `Closeness is also colored by the Moon. ${describePlacement("Moon", selfMoon, locale)} ${describePlacement("Moon", friendMoon, locale)}`),
        scoreFor("love_pleasure") >= 80
          ? localeText(locale, "Det här ser ut som en plats där attraktion och tillgivenhet hittar varandra ganska naturligt.", "This looks like a place where attraction and affection find each other rather naturally.")
          : scoreFor("love_pleasure") >= 63
            ? localeText(locale, "Det finns fin kemi, men ni kan behöva översätta vad som faktiskt känns romantiskt, tryggt eller njutbart för er var och en.", "There is good chemistry, but you may need to translate what actually feels romantic, safe, or pleasurable for each of you.")
            : localeText(locale, "Här är det lätt att tro att den andra automatiskt förstår kärleksspråket. I praktiken kommer ni närmare varandra genom att säga det högt.", "It is easy here to assume the other person automatically understands your love language. In practice, you get closer by saying it out loud.")
      ].join("\n\n"),
    },
    {
      key: "responsibility",
      title: localeText(locale, "Ansvar, vardag och hållbarhet", "Responsibility, daily life, and sustainability"),
      score: scoreFor("responsibility"),
      summary: noteFor("responsibility"),
      body: [
        `${describePlacement("Saturn", selfSaturn, locale)} ${describePlacement("Saturn", friendSaturn, locale)}`,
        localeText(locale, `${selfName} bär profilen ${selfHdProfile || "—"} och ${localizeHumanDesignValue(selfHdDefinition, locale)}, medan ${friendName} bär profilen ${friendHdProfile || "—"} och ${localizeHumanDesignValue(friendHdDefinition, locale)}. Det säger något om hur ni organiserar energi, ansvar och relationell timing.`, `${selfName} carries the ${selfHdProfile || "—"} profile and ${localizeHumanDesignValue(selfHdDefinition, locale)}, while ${friendName} carries the ${friendHdProfile || "—"} profile and ${localizeHumanDesignValue(friendHdDefinition, locale)}. That says something about how you organize energy, responsibility, and relational timing.`),
        scoreFor("responsibility") >= 80
          ? localeText(locale, "Här finns god potential för något hållbart. Ni har olika nyanser, men de verkar inte dra åt helt olika håll.", "There is good potential for something lasting here. You have different nuances, but they do not seem to pull in entirely different directions.")
          : scoreFor("responsibility") >= 63
            ? localeText(locale, "Ni kan bygga fint ihop, men vardagsansvar och långsiktighet behöver uttalas snarare än antas.", "You can build well together, but daily responsibility and long-term expectations need to be spoken rather than assumed.")
            : localeText(locale, "Om ni inte pratar tydligt om ansvar kan ni börja bära relationen på olika sätt utan att märka det. Då kommer slitningen smygande.", "If you do not talk clearly about responsibility, you may start carrying the relationship in different ways without noticing. That is how strain creeps in.")
      ].join("\n\n"),
    },
    {
      key: "sex_aggression",
      title: localeText(locale, "Driv, sexuell kemi och friktion", "Drive, sexual chemistry, and friction"),
      score: scoreFor("sex_aggression"),
      summary: noteFor("sex_aggression"),
      body: [
        localeText(locale, `${selfName} bär Mars i ${localizeAstroSign(selfMars, locale)} och ${friendName} bär Mars i ${localizeAstroSign(friendMars, locale)}. ${describePlacement("Mars", selfMars, locale)} ${describePlacement("Mars", friendMars, locale)}`, `${selfName} carries Mars in ${localizeAstroSign(selfMars, locale)} and ${friendName} carries Mars in ${localizeAstroSign(friendMars, locale)}. ${describePlacement("Mars", selfMars, locale)} ${describePlacement("Mars", friendMars, locale)}`),
        localeText(locale, `Ascendenten visar också hur ni möter tryck och laddning i stunden. ${describePlacement("Ascendant", selfAsc, locale)} ${describePlacement("Ascendant", friendAsc, locale)}`, `The Ascendant also shows how you meet pressure and charge in the moment. ${describePlacement("Ascendant", selfAsc, locale)} ${describePlacement("Ascendant", friendAsc, locale)}`),
        scoreFor("sex_aggression") >= 80
          ? localeText(locale, "Här finns ofta stark gnista utan att allt behöver bli kamp. Det kan bli levande, lekfullt och tydligt.", "There is often strong spark here without everything turning into a fight. It can feel alive, playful, and clear.")
          : scoreFor("sex_aggression") >= 63
            ? localeText(locale, "Det finns kemi, men ni triggas inte av exakt samma saker. Därför blir det viktigt att prata om tempo, initiativ och vad som känns tryggt.", "There is chemistry here, but you are not activated by exactly the same things. That makes it important to talk about pace, initiative, and what feels safe.")
            : localeText(locale, "Det här är ett område där attraktion och irritation kan ligga nära varandra. Tydliga gränser gör stor skillnad.", "This is an area where attraction and irritation can sit close together. Clear boundaries make a big difference.")
      ].join("\n\n"),
    },
    {
      key: "philosophies_of_life",
      title: localeText(locale, "Mening, riktning och livssyn", "Meaning, direction, and worldview"),
      score: scoreFor("philosophies_of_life"),
      summary: noteFor("philosophies_of_life"),
      body: [
        `${describePlacement("Jupiter", selfJupiter, locale)} ${describePlacement("Jupiter", friendJupiter, locale)}`,
        localeText(locale, `I bakgrunden färgar också Solen och era kinesiska tecken berättelsen: ${selfName} bär ${localizeAstroSign(selfSun, locale)} och ${localizeChineseAnimal(selfChinese, locale)}, medan ${friendName} bär ${localizeAstroSign(friendSun, locale)} och ${localizeChineseAnimal(friendChinese, locale)}.`, `In the background, the Sun and your Chinese zodiac signs also color the story: ${selfName} carries ${localizeAstroSign(selfSun, locale)} and ${localizeChineseAnimal(selfChinese, locale)}, while ${friendName} carries ${localizeAstroSign(friendSun, locale)} and ${localizeChineseAnimal(friendChinese, locale)}.`),
        scoreFor("philosophies_of_life") >= 80
          ? localeText(locale, "När det här området är starkt får relationen ofta en känsla av gemensam riktning. Ni förstår ganska lätt varför den andra bryr sig om det den bryr sig om.", "When this area is strong, the relationship often gains a feeling of shared direction. You understand fairly easily why the other person cares about what they care about.")
          : scoreFor("philosophies_of_life") >= 63
            ? localeText(locale, "Ni kan inspirera varandra, men ni utgår inte alltid från samma karta. Det behöver inte vara ett problem så länge olikhet inte görs till fel.", "You can inspire each other, but you do not always begin from the same map. That does not have to be a problem as long as difference is not treated as wrong.")
            : localeText(locale, "Det här ser ut som er tydligaste utvecklingszon. Om ni pressar fram samsyn för snabbt kan det i stället skapa avstånd.", "This looks like your clearest development zone. If you push for agreement too quickly, it can create distance instead.")
      ].join("\n\n"),
    },
  ];

  return {
    intro:
      overall >= 80
        ? localeText(locale, `Min läsning: som kärlekspar ser ${selfName} och ${friendName} ut att ha stark dragningskraft och ovanligt god potential. Det här är inte helt friktionsfritt, men mycket bär av sig självt. Jag skulle sätta det till ungefär ${formatCompatibilityOutOfTen(deepDiveLovePotential, locale, 1)}/10 astrologiskt och Human Design-mässigt.`, `My reading: as a love match, ${selfName} and ${friendName} show strong attraction and unusually good potential. This is not completely frictionless, but a lot of it carries itself. I would put it at about ${formatCompatibilityOutOfTen(deepDiveLovePotential, locale, 1)}/10 astrologically and in Human Design terms.`)
      : overall >= 63
          ? localeText(locale, `Min läsning: som kärlekspar ser ${selfName} och ${friendName} ut att ha tydlig kemi och verklig potential, men det är inte en relation som glider helt av sig själv. Jag skulle sätta det till ungefär ${formatCompatibilityOutOfTen(deepDiveLovePotential, locale, 1)}/10 astrologiskt och Human Design-mässigt.`, `My reading: as a love match, ${selfName} and ${friendName} show clear chemistry and real potential, but this is not a bond that runs entirely on autopilot. I would put it at about ${formatCompatibilityOutOfTen(deepDiveLovePotential, locale, 1)}/10 astrologically and in Human Design terms.`)
          : localeText(locale, `Min läsning: som kärlekspar ser ${selfName} och ${friendName} ut att ha stark laddning, men också flera tydliga översättningszoner. Det här kan bli fint, men det kräver mer medvetenhet än genomsnittet. Jag skulle sätta det till ungefär ${formatCompatibilityOutOfTen(deepDiveLovePotential, locale, 1)}/10 astrologiskt och Human Design-mässigt.`, `My reading: as a love match, ${selfName} and ${friendName} show strong charge, but also several clear translation zones. This can absolutely become meaningful, but it requires more awareness than average. I would put it at about ${formatCompatibilityOutOfTen(deepDiveLovePotential, locale, 1)}/10 astrologically and in Human Design terms.`),
    outro:
      overall >= 63
        ? localeText(locale, "Min slutsats är därför: ja, det här kan bli väldigt fint om ni är tydliga med behov, låter känslor få landa och inte försöker pressa fram likhet där ni egentligen är olika.", "My conclusion is this: yes, this can become something beautiful if you stay clear about needs, let emotions land, and do not force sameness where you are fundamentally different.")
        : localeText(locale, "Min slutsats är därför: det här är inte omöjligt, men ni behöver mer tålamod än charm. När ni lyckas möta varandra utan att vilja korrigera den andras natur finns ändå verklig potential.", "My conclusion is this: this is not impossible, but it will need more patience than charm. When you manage to meet each other without trying to correct the other's nature, there is still real potential here."),
    rating: deepDiveLovePotential,
    guidance: [
      weakestDimensionAdvice(weakestDimension.key, locale),
      selfHdAuthority && friendHdAuthority && selfHdAuthority === friendHdAuthority
        ? localeText(locale, "Eftersom båda har emotionell process vinner ni på att låta större känslor passera ett varv innan ni låser ett beslut.", "Because you both process emotionally, you benefit from letting bigger feelings complete a cycle before locking a decision.")
        : localeText(locale, "Var nyfikna på att trygghet kan se olika ut för er två, även när ni vill samma sak.", "Stay curious about the fact that safety may look different for each of you, even when you want the same thing."),
      localeText(locale, "Försök inte ändra varandras natur för snabbt. Relationen blir starkare när skillnader får bli tydliga innan ni försöker lösa dem.", "Do not try to change each other's nature too quickly. The bond gets stronger when differences are allowed to become clear before you try to solve them."),
    ],
    sections,
  };
};

const buildCompatibilityReport = (
  selfInsights: any,
  friendInsights: any,
  locale: string,
  displayNames?: { self?: string | null; friend?: string | null }
) => {
  const selfSummary = selfInsights?.summary_json || {};
  const friendSummary = friendInsights?.summary_json || {};
  const basicIdentities = scoreToPercent(
    averageCompatibility(
      compareSignPlacement(getPlanetSign(selfInsights, "Sun"), getPlanetSign(friendInsights, "Sun"), 0.94, 0.72),
      compareSignPlacement(getPlanetSign(selfInsights, "Ascendant"), getPlanetSign(friendInsights, "Ascendant"), 0.88, 0.68),
      compareHumanDesignType(selfSummary?.human_design?.type, friendSummary?.human_design?.type),
      compareChineseZodiac(selfSummary?.chinese_zodiac, friendSummary?.chinese_zodiac)
    )
  );
  const moodsAndEmotions = scoreToPercent(
    averageCompatibility(
      compareSignPlacement(getPlanetSign(selfInsights, "Moon"), getPlanetSign(friendInsights, "Moon"), 0.94, 0.72),
      compareExactOrNear(selfSummary?.human_design?.authority, friendSummary?.human_design?.authority, 0.9, 0.72)
    )
  );
  const intellectAndCommunication = scoreToPercent(
    averageCompatibility(
      compareSignPlacement(getPlanetSign(selfInsights, "Mercury"), getPlanetSign(friendInsights, "Mercury"), 0.95, 0.74),
      compareExactOrNear(selfSummary?.human_design?.strategy, friendSummary?.human_design?.strategy, 0.82, 0.68)
    )
  );
  const loveAndPleasure = scoreToPercent(
    averageCompatibility(
      compareSignPlacement(getPlanetSign(selfInsights, "Venus"), getPlanetSign(friendInsights, "Venus"), 0.95, 0.74),
      compareSignPlacement(getPlanetSign(selfInsights, "Moon"), getPlanetSign(friendInsights, "Moon"), 0.9, 0.7)
    )
  );
  const responsibility = scoreToPercent(
    averageCompatibility(
      compareSignPlacement(getPlanetSign(selfInsights, "Saturn"), getPlanetSign(friendInsights, "Saturn"), 0.9, 0.68),
      compareExactOrNear(selfSummary?.human_design?.profile, friendSummary?.human_design?.profile, 0.86, 0.72),
      compareExactOrNear(selfSummary?.human_design?.strategy, friendSummary?.human_design?.strategy, 0.78, 0.64)
    )
  );
  const sexAndAggression = scoreToPercent(
    averageCompatibility(
      compareSignPlacement(getPlanetSign(selfInsights, "Mars"), getPlanetSign(friendInsights, "Mars"), 0.93, 0.7),
      compareSignPlacement(getPlanetSign(selfInsights, "Ascendant"), getPlanetSign(friendInsights, "Ascendant"), 0.86, 0.66),
      compareHumanDesignType(selfSummary?.human_design?.type, friendSummary?.human_design?.type)
    )
  );
  const philosophiesOfLife = scoreToPercent(
    averageCompatibility(
      compareSignPlacement(getPlanetSign(selfInsights, "Jupiter"), getPlanetSign(friendInsights, "Jupiter"), 0.9, 0.72),
      compareSignPlacement(getPlanetSign(selfInsights, "Sun"), getPlanetSign(friendInsights, "Sun"), 0.86, 0.68),
      compareChineseZodiac(selfSummary?.chinese_zodiac, friendSummary?.chinese_zodiac)
    )
  );

  const coreDimensions = [
    {
      key: "basic_identities",
      label: localeText(locale, "Grundidentiteter", "Basic identities"),
      focus: localeText(locale, "grundidentiteter", "basic identities"),
      score: basicIdentities,
      note: scoreLabel(
        basicIdentities,
        locale,
        [
          "Era grundidentiteter och sociala uttryck känns ovanligt lätta att känna igen hos varandra.",
          "Your core identities and social expression feel unusually easy to recognize in each other.",
        ],
        [
          "Ni kan förstå varandras grundenergi, men ni visar er på olika sätt.",
          "You can understand each other's core energy, though you express it differently.",
        ],
        [
          "Självbild och första intryck kan skava tills ni lärt er läsa varandra bättre.",
          "Self-image and first impressions may rub until you learn to read each other better.",
        ]
      ),
    },
    {
      key: "moods_emotions",
      label: localeText(locale, "Humör & känslor", "Moods & emotions"),
      focus: localeText(locale, "humör och känslor", "moods and emotions"),
      score: moodsAndEmotions,
      note: scoreLabel(
        moodsAndEmotions,
        locale,
        [
          "Era känslolägen verkar ganska lätta att möta och reglera tillsammans.",
          "Your emotional weather seems fairly easy to meet and regulate together.",
        ],
        [
          "Ni kan förstå varandra emotionellt, men ni lugnar inte alltid systemet på samma sätt.",
          "You can understand each other emotionally, but you do not always regulate in the same way.",
        ],
        [
          "Här behövs extra varsamhet så att känslor inte feltolkas eller lämnas ensamma.",
          "This area needs extra care so feelings are not misread or left alone.",
        ]
      ),
    },
    {
      key: "intellect_communication",
      label: localeText(locale, "Intellekt & kommunikation", "Intellect & communication"),
      focus: localeText(locale, "intellekt och kommunikation", "intellect and communication"),
      score: intellectAndCommunication,
      note: scoreLabel(
        intellectAndCommunication,
        locale,
        [
          "Ni snappar snabbt hur den andra tänker och det är lätt att få fart i samtal.",
          "You grasp how the other thinks quickly, and conversation gets moving easily.",
        ],
        [
          "Samtalen kan bli bra, men ni behöver ibland olika tempo för att tänka klart.",
          "Conversation can be good, but you sometimes need different pace to think clearly.",
        ],
        [
          "Här kan missförstånd byggas upp snabbare, så tydlighet och timing blir viktigt.",
          "Misunderstandings can build faster here, so clarity and timing become important.",
        ]
      ),
    },
    {
      key: "love_pleasure",
      label: localeText(locale, "Kärlek & njutning", "Love & pleasure"),
      focus: localeText(locale, "kärlek och njutning", "love and pleasure"),
      score: loveAndPleasure,
      note: scoreLabel(
        loveAndPleasure,
        locale,
        [
          "Det finns lätthet i vad ni tycker om, hur ni flirtar och vad som känns njutbart.",
          "There is ease in what you enjoy, how you flirt, and what feels pleasurable.",
        ],
        [
          "Attraktion finns, men smak och rytm behöver ibland översättas.",
          "There is attraction, but taste and rhythm sometimes need translation.",
        ],
        [
          "Njutning och tillgivenhet behöver mer aktiv finjustering för att landa rätt.",
          "Pleasure and affection need more active fine-tuning to land well.",
        ]
      ),
    },
    {
      key: "responsibility",
      label: localeText(locale, "Ansvarskänsla", "Sense of responsibility"),
      focus: localeText(locale, "ansvarskänsla", "sense of responsibility"),
      score: responsibility,
      note: scoreLabel(
        responsibility,
        locale,
        [
          "Ni verkar ta ansvar på sätt som kan stötta en stabil vardag tillsammans.",
          "You seem to carry responsibility in ways that can support a stable daily life together.",
        ],
        [
          "Ni kan bygga något hållbart, men ansvar fördelas inte automatiskt likadant.",
          "You can build something lasting, though responsibility is not distributed the same way automatically.",
        ],
        [
          "Förväntningar, plikt och långsiktighet måste uttalas tydligt för att inte skava.",
          "Expectations, duty, and long-term responsibility need to be spoken clearly to avoid friction.",
        ]
      ),
    },
    {
      key: "sex_aggression",
      label: localeText(locale, "Sex & aggression", "Sex & aggression"),
      focus: localeText(locale, "sex och aggression", "sex and aggression"),
      score: sexAndAggression,
      note: scoreLabel(
        sexAndAggression,
        locale,
        [
          "Driv, lust och konfliktsvar kan hitta en levande men begriplig rytm.",
          "Drive, desire, and conflict responses can find a vivid but understandable rhythm.",
        ],
        [
          "Det finns kemi, men också olika sätt att ta initiativ eller reagera under press.",
          "There is chemistry, but also different ways of taking initiative or reacting under pressure.",
        ],
        [
          "Tempo, irritation och begär kan haka i varandra om ni inte pratar tydligt om det.",
          "Tempo, irritation, and desire can snag on each other if you do not talk about them clearly.",
        ]
      ),
    },
    {
      key: "philosophies_of_life",
      label: localeText(locale, "Livsfilosofier", "Philosophies of life"),
      focus: localeText(locale, "livsfilosofier", "philosophies of life"),
      score: philosophiesOfLife,
      note: scoreLabel(
        philosophiesOfLife,
        locale,
        [
          "Ni verkar dela en ganska kompatibel känsla för mening, tro och riktning i livet.",
          "You seem to share a fairly compatible sense of meaning, belief, and direction in life.",
        ],
        [
          "Ni kan inspirera varandra, men ni utgår inte alltid från samma världsbild.",
          "You can inspire each other, though you do not always begin from the same worldview.",
        ],
        [
          "Här behöver ni ge extra plats åt olika livssyner, annars blir avståndet tydligt.",
          "This area needs extra room for different life views, otherwise distance becomes obvious.",
        ]
      ),
    },
  ];

  const weakestDimension = coreDimensions.reduce((lowest, next) => (next.score < lowest.score ? next : lowest));
  const strongestDimension = coreDimensions.reduce((highest, next) => (next.score > highest.score ? next : highest));
  const workOn = Math.max(0, Math.min(100, 100 - weakestDimension.score));
  const easy = strongestDimension.score;
  const overall = Math.round(
    basicIdentities * 0.16 +
      moodsAndEmotions * 0.16 +
      intellectAndCommunication * 0.14 +
      loveAndPleasure * 0.16 +
      responsibility * 0.12 +
      sexAndAggression * 0.12 +
      philosophiesOfLife * 0.14
  );
  return {
    overall,
    band: scoreLabel(
      overall,
      locale,
      ["Stark kompatibilitet", "Strong compatibility"],
      ["Lovande dynamik", "Promising dynamic"],
      ["Blandad men möjlig", "Mixed but workable"]
    ),
    summary:
      overall >= 80
        ? localeText(
            locale,
            `Ni har mycket som flyter naturligt, särskilt inom ${strongestDimension.focus}. Er viktigaste medvetna punkt blir ${weakestDimension.focus}.`,
            `A lot seems to flow naturally between you, especially around ${strongestDimension.focus}. Your biggest conscious growth point looks like ${weakestDimension.focus}.`
          )
        : overall >= 63
          ? localeText(
              locale,
              `Ni har flera tydliga träffpunkter, och det som ser lättast ut just nu är ${strongestDimension.focus}. Mest medvetenhet behövs kring ${weakestDimension.focus}.`,
              `You have several clear points of connection, and ${strongestDimension.focus} looks easiest right now. The most conscious work is likely needed around ${weakestDimension.focus}.`
            )
          : localeText(
              locale,
              `Ni kan absolut fungera ihop, men det kräver mer tålamod kring ${weakestDimension.focus}. Det som ändå kan bära er är styrkan i ${strongestDimension.focus}.`,
              `You can absolutely work together, but it will take more patience around ${weakestDimension.focus}. What can still carry you is the strength in ${strongestDimension.focus}.`
            ),
    dimensions: [
      ...coreDimensions.map(({ key, label, score, note }) => ({ key, label, score, note })),
      {
        key: "work_on",
        label: localeText(locale, "Det ni behöver jobba på", "What you will have to work on"),
        score: workOn,
        note:
          workOn >= 70
            ? localeText(
                locale,
                `Ert största utvecklingsområde ser ut att ligga i ${weakestDimension.focus}. Här krävs tydlighet, tålamod och återkommande avstämningar.`,
                `Your biggest growth area seems to sit in ${weakestDimension.focus}. This will require clarity, patience, and recurring check-ins.`
              )
            : workOn >= 40
              ? localeText(
                  locale,
                  `Mest medvetenhet behövs kring ${weakestDimension.focus}. Det är inte ett stopp, men det behöver aktiv omsorg.`,
                  `The most awareness is needed around ${weakestDimension.focus}. It is not a dead end, but it does need active care.`
                )
              : localeText(
                  locale,
                  `Det finns något att vårda i ${weakestDimension.focus}, men inget som ser ovanligt tungt ut just nu.`,
                  `There is something to tend in ${weakestDimension.focus}, but nothing unusually heavy there right now.`
                ),
      },
      {
        key: "easy",
        label: localeText(locale, "Det som kommer lätt", "What will be easy"),
        score: easy,
        note:
          easy >= 80
            ? localeText(
                locale,
                `Det mest självgående området mellan er verkar vara ${strongestDimension.focus}. Där finns naturligt flyt och snabb igenkänning.`,
                `The most self-running area between you seems to be ${strongestDimension.focus}. There is natural flow and quick recognition there.`
              )
            : easy >= 63
              ? localeText(
                  locale,
                  `Det som troligen känns lättast mellan er är ${strongestDimension.focus}. Det kan bli er tryggaste grund att bygga från.`,
                  `What will likely feel easiest between you is ${strongestDimension.focus}. That can become your safest base to build from.`
                )
              : localeText(
                  locale,
                  `Inget område sticker ut som helt friktionsfritt ännu, men ${strongestDimension.focus} ser ändå mest lovande ut.`,
                  `No area stands out as entirely friction-free yet, but ${strongestDimension.focus} still looks the most promising.`
                ),
      },
    ],
    deep_dive: buildCompatibilityDeepDive(selfInsights, friendInsights, locale, overall, coreDimensions, weakestDimension, displayNames),
  };
};

const loadCompatibilityContext = async ({
  userId,
  targetUserId,
  authHeaders,
  locale,
}: {
  userId: string;
  targetUserId: string;
  authHeaders: Record<string, string>;
  locale: string;
}): Promise<
  | {
      ok: true;
      membership: any;
      friendIdentity: any;
      report: ReturnType<typeof buildCompatibilityReport>;
      displayNames: { self: string; friend: string };
    }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
    }
> => {
  await syncMembershipIdentity(userId, authHeaders);
  const membership = await getMembershipRow(userId);
  if (!membership?.active) {
    return {
      ok: false,
      status: 402,
      error: "membership_required",
      message: apiErrorMessage("membership_required", locale),
    };
  }
  if (!(await areAcceptedFriends(userId, targetUserId))) {
    return {
      ok: false,
      status: 403,
      error: "friendship_required",
      message: apiErrorMessage("friendship_required", locale),
    };
  }

  const [selfInsightsRes, targetInsightsRes, targetMembershipRes] = await Promise.all([
    pool.query(
      `SELECT insight_id, summary_json, astrology_json, human_design_json, created_at
       FROM profile_insights
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    ),
    pool.query(
      `SELECT insight_id, summary_json, astrology_json, human_design_json, created_at
       FROM profile_insights
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [targetUserId]
    ),
    pool.query(
      `SELECT user_id, username, display_name, tier, ai_access
       FROM user_memberships
       WHERE user_id = $1`,
      [targetUserId]
    ),
  ]);

  if (!selfInsightsRes.rowCount || !targetInsightsRes.rowCount) {
    return {
      ok: false,
      status: 400,
      error: "profile_required",
      message: apiErrorMessage("profile_required", locale),
    };
  }

  const friendIdentity = targetMembershipRes.rowCount ? targetMembershipRes.rows[0] : { user_id: targetUserId };
  const displayNames = {
    self:
      membership?.display_name ||
      membership?.username ||
      authHeaders["x-authentik-name"] ||
      authHeaders["x-authentik-username"] ||
      localeText(locale, "Du", "You"),
    friend:
      friendIdentity?.display_name ||
      friendIdentity?.username ||
      friendIdentity?.user_id ||
      localeText(locale, "Din vän", "Your friend"),
  };

  return {
    ok: true,
    membership,
    friendIdentity,
    report: buildCompatibilityReport(selfInsightsRes.rows[0], targetInsightsRes.rows[0], locale, displayNames),
    displayNames,
  };
};

const buildCompatibilityEmail = ({
  compatibility,
  locale,
  reportUrl,
  displayNames,
}: {
  compatibility: any;
  locale: string;
  reportUrl: string;
  displayNames?: { self?: string | null; friend?: string | null };
}) => {
  const safeLocale = String(locale || "en-US").trim() || "en-US";
  const selfName = String(displayNames?.self || "").trim() || localeText(safeLocale, "Du", "You");
  const friendName =
    String(
      displayNames?.friend ||
        compatibility?.friend?.display_name ||
        compatibility?.friend?.username ||
        compatibility?.friend?.user_id ||
        ""
    ).trim() || localeText(safeLocale, "Din vän", "Your friend");
  const deepDive = compatibility?.deep_dive ?? {};
  const ratingRaw =
    typeof deepDive?.rating === "number" && Number.isFinite(deepDive.rating)
      ? deepDive.rating
      : Math.max(0, Math.min(100, Number(compatibility?.overall || 0)));
  const ratingText = `${formatCompatibilityOutOfTen(ratingRaw, safeLocale, 1)}/10`;
  const subject = localeText(
    safeLocale,
    `Horoskopjämförelse: ${selfName} och ${friendName}`,
    `Compatibility Reading: ${selfName} and ${friendName}`
  );
  const intro = String(deepDive?.intro || compatibility?.summary || "").trim();
  const outro = String(deepDive?.outro || "").trim();
  const guidance = Array.isArray(deepDive?.guidance) ? deepDive.guidance.filter(Boolean) : [];
  const sections = Array.isArray(deepDive?.sections) ? deepDive.sections.filter(Boolean) : [];
  const previewSectionKeys = new Set(["basic_identities", "love_pleasure"]);
  const previewDimensions = (Array.isArray(compatibility?.dimensions) ? compatibility.dimensions : [])
    .filter((dimension: any) =>
      ["basic_identities", "moods_emotions", "intellect_communication", "love_pleasure"].includes(String(dimension?.key || ""))
    )
    .slice(0, 4);
  const previewSections = sections.filter((section: any) => previewSectionKeys.has(String(section?.key || ""))).slice(0, 2);
  const attachmentHint = localeText(
    safeLocale,
    "Resten av djupjämförelsen finns i den bifogade HTML-filen.",
    "The rest of the deep reading is included in the attached HTML file."
  );
  const openLabel = localeText(safeLocale, "Öppna i STARDOM", "Open in STARDOM");
  const previewTitle = localeText(safeLocale, "Djup horoskopjämförelse", "Deep compatibility reading");
  const guidanceTitle = localeText(safeLocale, "Det här behöver ni vara rädda om", "What you need to protect");

  const renderBodyParagraphs = (value: string) =>
    String(value || "")
      .split(/\n\n+/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map(
        (paragraph) =>
          `<p style="margin:0 0 12px;font-size:16px;line-height:1.7;color:#f3ead9;">${escapeHtml(paragraph)}</p>`
      )
      .join("");

  const previewDimensionsHtml = previewDimensions
    .map(
      (dimension: any) => `<td valign="top" style="padding:6px;">
        <div style="height:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:14px 14px 12px;">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:8px;">
            <strong style="font-size:15px;line-height:1.35;color:#fff3de;">${escapeHtml(String(dimension?.label || "—"))}</strong>
            <span style="font-size:13px;line-height:1.2;color:#f0c88f;">${escapeHtml(String(dimension?.score ?? "—"))}/100</span>
          </div>
          <p style="margin:0;font-size:14px;line-height:1.6;color:#e8ddc9;">${escapeHtml(String(dimension?.note || ""))}</p>
        </div>
      </td>`
    )
    .join("");

  const previewSectionsHtml = previewSections
    .map(
      (section: any) => `<tr>
        <td style="padding:0 0 14px;">
          <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);border-radius:18px;padding:18px;">
            <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:8px;flex-wrap:wrap;">
              <h3 style="margin:0;font-size:22px;line-height:1.2;color:#fff1d4;">${escapeHtml(String(section?.title || ""))}</h3>
              <span style="display:inline-block;padding:6px 10px;border-radius:999px;background:rgba(255,214,144,0.12);border:1px solid rgba(255,214,144,0.2);font-size:13px;color:#ffdca8;">${escapeHtml(
                String(section?.score ?? "—")
              )}/100</span>
            </div>
            <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#ffdca8;">${escapeHtml(String(section?.summary || ""))}</p>
            ${renderBodyParagraphs(String(section?.body || ""))}
          </div>
        </td>
      </tr>`
    )
    .join("");

  const guidanceHtml = guidance.length
    ? `<tr>
        <td style="padding:0 0 14px;">
          <div style="background:rgba(255,215,140,0.08);border:1px solid rgba(255,215,140,0.18);border-radius:18px;padding:18px;">
            <h3 style="margin:0 0 12px;font-size:20px;line-height:1.2;color:#fff1d4;">${escapeHtml(guidanceTitle)}</h3>
            <ul style="margin:0;padding:0 0 0 18px;color:#f3ead9;">
              ${guidance
                .map(
                  (item: string) =>
                    `<li style="margin:0 0 10px;font-size:15px;line-height:1.65;">${escapeHtml(item)}</li>`
                )
                .join("")}
            </ul>
          </div>
        </td>
      </tr>`
    : "";

  const html = `<!doctype html>
<html lang="${escapeHtml(safeLocale)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#efe5d4;color:#1f1610;font-family:Georgia,'Times New Roman',serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#efe5d4;">
      <tr>
        <td align="center" style="padding:20px 12px 32px;">
          <table role="presentation" width="680" cellspacing="0" cellpadding="0" style="width:100%;max-width:680px;border-collapse:collapse;">
            <tr>
              <td style="background:linear-gradient(135deg,#17192f 0%,#1f1430 58%,#382619 100%);border:1px solid #403752;border-radius:28px;padding:24px 22px;color:#f0e8d9;">
                <p style="margin:0 0 10px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#f0c88f;">SPUTNET WORLD</p>
                <h1 style="margin:0 0 12px;font-size:42px;line-height:1.04;color:#f7ecda;">${escapeHtml(previewTitle)}</h1>
                <p style="margin:0 0 18px;font-size:18px;line-height:1.6;color:#f0e8d9;">${escapeHtml(
                  localeText(
                    safeLocale,
                    `${selfName} och ${friendName} har nu en sparad djupjämförelse via astrologi och Human Design.`,
                    `${selfName} and ${friendName} now have a saved deep reading through astrology and Human Design.`
                  )
                )}</p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-bottom:16px;">
                  <tr>
                    <td valign="top" style="padding:0 10px 10px 0;">
                      <div style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:14px 16px;">
                        <div style="font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#d9d0c2;margin-bottom:6px;">${escapeHtml(
                          localeText(safeLocale, "Betyg", "Rating")
                        )}</div>
                        <div style="font-size:30px;line-height:1.1;color:#fff3de;font-weight:700;">${escapeHtml(ratingText)}</div>
                      </div>
                    </td>
                    <td valign="top" style="padding:0 0 10px 10px;">
                      <div style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:14px 16px;">
                        <div style="font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#d9d0c2;margin-bottom:6px;">${escapeHtml(
                          localeText(safeLocale, "Dynamik", "Dynamic")
                        )}</div>
                        <div style="font-size:24px;line-height:1.2;color:#fff3de;font-weight:700;">${escapeHtml(
                          String(compatibility?.band || "—")
                        )}</div>
                      </div>
                    </td>
                  </tr>
                </table>

                ${renderBodyParagraphs(intro)}

                ${
                  previewDimensionsHtml
                    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:16px 0 12px;">
                        <tr>${previewDimensionsHtml}</tr>
                      </table>`
                    : ""
                }

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:8px;">
                  ${previewSectionsHtml}
                  ${guidanceHtml}
                  ${
                    outro
                      ? `<tr><td style="padding:0 0 14px;"><div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:16px;">${renderBodyParagraphs(
                          outro
                        )}</div></td></tr>`
                      : ""
                  }
                </table>

                <div style="margin-top:16px;padding:16px 18px;border-radius:18px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);">
                  <p style="margin:0 0 10px;font-size:15px;line-height:1.65;color:#f0e8d9;">${escapeHtml(attachmentHint)}</p>
                  ${
                    reportUrl
                      ? `<a href="${escapeHtml(reportUrl)}" style="display:inline-block;padding:11px 18px;border-radius:999px;background:#db4a2b;color:#ffffff;text-decoration:none;font-weight:700;">${escapeHtml(
                          openLabel
                        )}</a>`
                      : ""
                  }
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const attachmentSectionsHtml = sections
    .map((section: any) => {
      const paragraphs = String(section?.body || "")
        .split(/\n\n+/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
        .join("");
      return `<article class="section-card">
        <div class="section-card__head">
          <h2>${escapeHtml(String(section?.title || ""))}</h2>
          <span>${escapeHtml(String(section?.score ?? "—"))}/100</span>
        </div>
        <p class="section-card__summary">${escapeHtml(String(section?.summary || ""))}</p>
        ${paragraphs}
      </article>`;
    })
    .join("");

  const attachmentDimensionsHtml = (Array.isArray(compatibility?.dimensions) ? compatibility.dimensions : [])
    .map(
      (dimension: any) => `<article class="metric-card">
        <div class="metric-card__head">
          <strong>${escapeHtml(String(dimension?.label || "—"))}</strong>
          <span>${escapeHtml(String(dimension?.score ?? "—"))}/100</span>
        </div>
        <p>${escapeHtml(String(dimension?.note || ""))}</p>
      </article>`
    )
    .join("");

  const attachmentHtml = `<!doctype html>
<html lang="${escapeHtml(safeLocale)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
    <style>
      @import url("https://fonts.googleapis.com/css2?family=Fraunces:wght@600;700&family=Space+Grotesk:wght@400;500;600&display=swap");
      :root {
        color-scheme: dark;
        --bg: #f1e7d8;
        --shell: linear-gradient(135deg, #17192f 0%, #1f1430 58%, #382619 100%);
        --line: rgba(255,255,255,0.12);
        --card: rgba(255,255,255,0.05);
        --ink: #f6ecdc;
        --muted: #d8cfbe;
        --warm: #ffd9a0;
        --accent: #db4a2b;
      }
      * {
        box-sizing: border-box;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      @page {
        size: A4;
        margin: 12mm;
      }
      html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--ink); }
      body { padding: 24px 16px 48px; font-family: "Space Grotesk", Arial, sans-serif; }
      .wrap { width: min(980px, 100%); margin: 0 auto; }
      .shell {
        background: var(--shell);
        border: 1px solid rgba(58, 52, 74, 0.9);
        border-radius: 28px;
        padding: 28px;
        box-shadow: 0 26px 80px rgba(19, 15, 24, 0.28);
      }
      .eyebrow {
        margin: 0 0 10px;
        font-size: 12px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: #f0c88f;
      }
      h1 {
        margin: 0 0 12px;
        font-size: clamp(2.5rem, 5vw, 4rem);
        line-height: 0.98;
        color: #fff1d9;
        font-family: "Fraunces", Georgia, serif;
      }
      .lead,
      .section-card p,
      .metric-card p,
      .outro,
      li {
        margin: 0;
        font-size: 1.08rem;
        line-height: 1.75;
        color: var(--ink);
      }
      .hero-grid,
      .metric-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 14px;
      }
      .hero-grid { margin: 18px 0 22px; }
      .hero-card,
      .metric-card,
      .section-card,
      .guidance,
      .outro {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 18px;
      }
      .hero-card,
      .metric-card { padding: 16px; }
      .hero-card__label {
        margin: 0 0 8px;
        font-size: 12px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .hero-card__value {
        margin: 0;
        font-size: 1.85rem;
        line-height: 1.2;
        color: #fff3de;
        font-weight: 700;
        font-family: "Fraunces", Georgia, serif;
      }
      .intro {
        margin: 0 0 22px;
        font-size: 1.16rem;
        line-height: 1.8;
        color: var(--ink);
      }
      .metric-grid,
      .sections {
        margin-top: 18px;
      }
      .metric-card__head,
      .section-card__head {
        display: flex;
        gap: 12px;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 10px;
      }
      .metric-card__head strong,
      .section-card__head h2 {
        margin: 0;
        font-size: 1.15rem;
        line-height: 1.3;
        color: #fff1d4;
        font-family: "Fraunces", Georgia, serif;
      }
      .metric-card__head span,
      .section-card__head span {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(255,214,144,0.12);
        border: 1px solid rgba(255,214,144,0.2);
        color: var(--warm);
        font-size: 0.9rem;
        white-space: nowrap;
      }
      .section-card {
        padding: 20px;
        margin-top: 14px;
      }
      .section-card__summary {
        margin: 0 0 12px;
        color: var(--warm);
      }
      .section-card p + p { margin-top: 12px; }
      .guidance,
      .outro {
        margin-top: 18px;
        padding: 18px 20px;
      }
      .guidance h2 {
        margin: 0 0 12px;
        font-size: 1.25rem;
        color: #fff1d4;
      }
      .guidance ul {
        margin: 0;
        padding-left: 20px;
        display: grid;
        gap: 10px;
      }
      .footer-link {
        margin-top: 20px;
      }
      .footer-link a {
        display: inline-block;
        padding: 12px 18px;
        border-radius: 999px;
        background: var(--accent);
        color: #ffffff;
        text-decoration: none;
        font-weight: 700;
      }
      @media print {
        body { padding: 0; }
        .wrap { width: 100%; }
        .shell { box-shadow: none; }
      }
      @media (max-width: 720px) {
        body { padding: 12px 8px 28px; }
        .shell { padding: 18px; border-radius: 22px; }
        .intro, .lead, .section-card p, .metric-card p, li { font-size: 1rem; }
        .metric-card__head, .section-card__head { flex-direction: column; align-items: flex-start; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <main class="shell">
        <p class="eyebrow">SPUTNET WORLD</p>
        <h1>${escapeHtml(subject)}</h1>
        <p class="intro">${escapeHtml(intro || compatibility?.summary || "")}</p>

        <section class="hero-grid">
          <article class="hero-card">
            <p class="hero-card__label">${escapeHtml(localeText(safeLocale, "Betyg", "Rating"))}</p>
            <p class="hero-card__value">${escapeHtml(ratingText)}</p>
          </article>
          <article class="hero-card">
            <p class="hero-card__label">${escapeHtml(localeText(safeLocale, "Dynamik", "Dynamic"))}</p>
            <p class="hero-card__value">${escapeHtml(String(compatibility?.band || "—"))}</p>
          </article>
          <article class="hero-card">
            <p class="hero-card__label">${escapeHtml(localeText(safeLocale, "Personer", "People"))}</p>
            <p class="hero-card__value">${escapeHtml(`${selfName} + ${friendName}`)}</p>
          </article>
        </section>

        <section class="metric-grid">${attachmentDimensionsHtml}</section>
        <section class="sections">${attachmentSectionsHtml}</section>

        ${
          guidance.length
            ? `<section class="guidance">
                <h2>${escapeHtml(guidanceTitle)}</h2>
                <ul>${guidance.map((item: string) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
              </section>`
            : ""
        }

        ${
          outro
            ? `<section class="outro"><p class="lead">${escapeHtml(outro)}</p></section>`
            : ""
        }

        ${
          reportUrl
            ? `<p class="footer-link"><a href="${escapeHtml(reportUrl)}">${escapeHtml(openLabel)}</a></p>`
            : ""
        }
      </main>
    </div>
  </body>
</html>`;

  const text = [
    subject,
    `${localeText(safeLocale, "Betyg", "Rating")}: ${ratingText}`,
    `${localeText(safeLocale, "Dynamik", "Dynamic")}: ${String(compatibility?.band || "—")}`,
    "",
    intro || String(compatibility?.summary || ""),
    "",
    ...previewDimensions.map(
      (dimension: any) => `${String(dimension?.label || "—")}: ${String(dimension?.score ?? "—")}/100\n${String(dimension?.note || "")}`
    ),
    "",
    guidance.length ? `${guidanceTitle}:\n${guidance.map((item: string) => `- ${item}`).join("\n")}` : "",
    "",
    attachmentHint,
    reportUrl ? `${openLabel}: ${reportUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const slugifyPart = (value: string) =>
    String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();

  const attachmentFileName = normalizeReportEmailFilename(
    `${localeText(safeLocale, "horoskopjamforelse", "compatibility-reading")}-${slugifyPart(selfName)}-${slugifyPart(friendName)}`
  );

  return { subject, html, text, attachmentHtml, attachmentFileName };
};

const extractOpenAiText = (payload: any): string => {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (typeof c?.text === "string" && c.text.trim()) {
        chunks.push(c.text.trim());
      }
    }
  }
  return chunks.join("\n\n").trim();
};

const fallbackOracleReply = (
  spreadLabel: string,
  message: string,
  cards: Array<{ slot: string; name: string; orientation: string }>,
  language = "en-US"
) => {
  const isSwedish = language.toLowerCase().startsWith("sv");
  const t = (sv: string, en: string) => (isSwedish ? sv : en);
  const orientationLabel = (orientation: string) => {
    if (!isSwedish) return orientation;
    if (orientation === "upright") return "upprätt";
    if (orientation === "reversed") return "omvänt";
    return orientation;
  };
  const cardLine = cards.length
    ? cards.map((c) => `${c.slot}: ${c.name} (${orientationLabel(c.orientation)})`).join("; ")
    : t("Korten är inte avslöjade ännu.", "The cards are not revealed yet.");
  if (isSwedish) {
    return [
      `Slöjan darrar kring din ${spreadLabel}.`,
      `Du sa: "${message}"`,
      `Kort i fokus: ${cardLine}`,
      "Mitt råd: andas djupt, välj en tydlig handling innan kvällen och säg din intention högt tre gånger.",
      "Berätta vad som skrämmer dig mest i den här situationen, och vad du innerst inne vill istället.",
    ].join("\n\n");
  }
  return [
    `The veil trembles around your ${spreadLabel} ritual.`,
    `You said: "${message}"`,
    `Cards in focus: ${cardLine}`,
    "My guidance: breathe, choose one clear action before tonight, and speak your intention out loud three times.",
    "Tell me what scares you most in this situation, and what you truly want instead.",
  ].join("\n\n");
};

const requestOracleReply = async (payload: {
  spreadLabel: string;
  spreadDescription: string;
  language?: string;
  message: string;
  answers: string[];
  cards: Array<{
    slot: string;
    name: string;
    orientation: "upright" | "reversed";
    summary?: string;
    upright?: string;
    reversed?: string;
  }>;
  profileContext?: {
    user?: { username?: string | null; name?: string | null } | null;
    astrology?: { sun?: string | null; moon?: string | null; ascendant?: string | null } | null;
    humanDesign?: {
      type?: string | null;
      profile?: string | null;
      strategy?: string | null;
      authority?: string | null;
      role?: string | null;
    } | null;
    chineseZodiac?: string | null;
  } | null;
  conversation: Array<{ role: "user" | "assistant"; text: string }>;
}) => {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  const model = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();
  if (!apiKey) {
    return fallbackOracleReply(
      payload.spreadLabel,
      payload.message,
      payload.cards.map((c) => ({ slot: c.slot, name: c.name, orientation: c.orientation })),
      payload.language || "en-US"
    );
  }
  const isSwedish = String(payload.language || "").toLowerCase().startsWith("sv");
  const t = (sv: string, en: string) => (isSwedish ? sv : en);
  const orientationLabel = (orientation: string) => {
    if (!isSwedish) return orientation;
    if (orientation === "upright") return "upprätt";
    if (orientation === "reversed") return "omvänt";
    return orientation;
  };
  const system = [
    t("Du är Madame Flood, en mystisk tarotoracle.", "You are Madame Flood, a mystical tarot oracle."),
    t(
      "Rollspela som en varm, teatralisk spådam men håll råden psykologiskt jordade och praktiska.",
      "Roleplay like a warm, theatrical fortune teller, but keep guidance psychologically grounded and practical."
    ),
    t(
      "Svara alltid som om du talar direkt till sökaren.",
      "Always respond as if you are talking directly to the seeker."
    ),
    t("Ställ minst en följdfråga i varje svar.", "Ask at least one follow-up question in each reply."),
    t(
      "Om kort finns, referera tydligt till positioner och orienteringar.",
      "If cards are provided, reference the slot positions and card orientations explicitly."
    ),
    t(
      "Om profilkontext finns (astrologi, human design, kinesisk zodiak), väv in den i tolkningen.",
      "If user profile context is provided (astrology, human design, chinese zodiac), weave it into the reading."
    ),
    payload.language
      ? t(`Svara endast på detta språk/locale: ${payload.language}.`, `Respond only in this language locale: ${payload.language}.`)
      : t("Svara på svenska.", "Respond in English."),
    t(
      "Nämn inte policyer, modellbegränsningar eller att du är en AI-assistent.",
      "Do not mention policies, model limits, or that you are an AI assistant."
    ),
  ].join(" ");
  const cardContext = payload.cards
    .map(
      (card) =>
        `${card.slot}: ${card.name} (${orientationLabel(card.orientation)})\n${t("Sammanfattning", "Summary")}: ${card.summary || ""}\n${t("Upprätt", "Upright")}: ${card.upright || ""}\n${t("Omvänt", "Reversed")}: ${card.reversed || ""}`
    )
    .join("\n\n");
  const conversationContext = payload.conversation
    .slice(-14)
    .map((m) => `${m.role === "assistant" ? t("Oraklet", "Oracle") : t("Sökaren", "Seeker")}: ${m.text}`)
    .join("\n");
  const profileContext = payload.profileContext
    ? JSON.stringify(payload.profileContext, null, 2)
    : "";
  const userPrompt = [
    `${t("Läggning", "Spread")}: ${payload.spreadLabel}`,
    `${t("Läggningsbeskrivning", "Spread description")}: ${payload.spreadDescription}`,
    payload.answers.length
      ? `${t("Viktiga svar från sökaren", "Key seeker answers")}: ${payload.answers.join(" | ")}`
      : "",
    profileContext ? `${t("Sökarens profilkontext", "Seeker profile context")}:\n${profileContext}` : "",
    payload.cards.length ? `${t("Kort", "Cards")}:\n${cardContext}` : t("Kort: inga än.", "Cards: none yet."),
    conversationContext ? `${t("Samtal hittills", "Conversation so far")}:\n${conversationContext}` : "",
    `${t("Senaste meddelande från sökaren", "Latest seeker message")}: ${payload.message}`,
    t(
      "Fortsätt nu den levande orakelsessionen med mystisk ton, stark insikt och konkreta råd.",
      "Now continue the live oracle session in a mystical tone with strong insight and concrete advice."
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "text", text: system }] },
        { role: "user", content: [{ type: "text", text: userPrompt }] },
      ],
      temperature: 0.9,
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`oracle_upstream_error:${response.status}:${errText}`);
  }
  const data = await response.json().catch(() => null);
  const reply = extractOpenAiText(data);
  if (!reply) {
    throw new Error("oracle_empty_reply");
  }
  return reply;
};

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/health/db" || req.url === "/api/health/db") {
    const started = Date.now();
    const response = {
      ok: true,
      db: { ok: false, ms: null as number | null },
      redis: { ok: false, ms: null as number | null },
    };
    Promise.allSettled([
      (async () => {
        const t0 = Date.now();
        await pool.query("SELECT 1");
        response.db.ok = true;
        response.db.ms = Date.now() - t0;
      })(),
      (async () => {
        const t0 = Date.now();
        const client = await getRedis();
        await client.ping();
        response.redis.ok = true;
        response.redis.ms = Date.now() - t0;
      })(),
    ])
      .then(() => {
        response.ok = response.db.ok && response.redis.ok;
      })
      .catch(() => {
        response.ok = false;
      })
      .finally(() => {
        res.writeHead(response.ok ? 200 : 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...response, ms: Date.now() - started }));
      });
    return;
  }
  if (req.url === "/api/debug/auth" && req.method === "GET") {
    const headers = getAuthentikHeaders(req.headers as Record<string, unknown>);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        headers: Object.fromEntries(
          Object.entries(headers).map(([key, value]) => [key, value ? "present" : "missing"])
        ),
      })
    );
    return;
  }
  if (silentDisco.handleHttpRequest(req, res)) {
    return;
  }
  if (req.url === "/api/profile" && req.method === "GET") {
    const authHeaders = getAuthentikHeaders(req.headers as Record<string, unknown>);
    const userId = authHeaders["x-authentik-uid"] ?? null;
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    Promise.all([
      pool.query(
        `SELECT user_id, birth_date::text as birth_date, birth_time::text as birth_time, unknown_time, birth_place, birth_lat, birth_lng, tz_name, tz_offset_minutes
         FROM user_profiles
         WHERE user_id = $1`,
        [userId]
      ),
      fetchAuthentikUserInfo(authHeaders),
    ])
      .then(async ([result, userInfo]) => {
        const row = result.rowCount ? result.rows[0] : null;
        if (row?.birth_date) {
          row.birth_date = toDateStringWithTz(row.birth_date, row.tz_name ?? null);
        }
        const sharedUser = await ensureSharedUserRecord(authHeaders, userInfo);
        const fallbackUser = {
          username: authHeaders["x-authentik-username"] ?? null,
          email: authHeaders["x-authentik-email"] ?? null,
          name: authHeaders["x-authentik-name"] ?? null,
        };
        const user = { ...(fallbackUser || {}), ...(userInfo || {}), ...(sharedUser || {}) };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, profile: row, user, missing: !row }));
      })
      .catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "db_error", details: String(err) }));
      });
    return;
  }
  if (req.url === "/api/profile/account" && req.method === "POST") {
    const authHeaders = getAuthentikHeaders(req.headers as Record<string, unknown>);
    const userId = authHeaders["x-authentik-uid"] ?? null;
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    parseJsonBody(req, REPORT_EMAIL_PAYLOAD_MAX_BYTES)
      .then(async (body) => {
        const fallbackUser = await ensureSharedUserRecord(authHeaders, null);
        const emailRaw = body?.email === undefined ? fallbackUser?.email ?? null : body?.email;
        const usernameRaw = body?.username === undefined ? fallbackUser?.username ?? null : body?.username;
        const nameRaw = body?.name === undefined ? fallbackUser?.name ?? null : body?.name;
        const normalizedEmail = sanitizeAccountValue(emailRaw, 320);
        if (normalizedEmail && !isValidEmail(normalizedEmail)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid_email" }));
          return;
        }
        const user = await updateSharedUserProfile(userId, {
          email: normalizedEmail,
          username: sanitizeAccountValue(usernameRaw, 128),
          name: sanitizeAccountValue(nameRaw, 128),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, user }));
      })
      .catch((err) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid_payload", details: String(err) }));
      });
    return;
  }
  if (req.url === "/api/profile" && req.method === "POST") {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    parseJsonBody(req)
      .then((body) => {
        const birthDate = toDateString(body?.birthDate || "");
        const birthTime = String(body?.birthTime || "").trim();
        const unknownTime = Boolean(body?.unknownTime);
        const birthPlace = String(body?.birthPlace || "").trim();
        const birthLat = body?.birthLat === null || body?.birthLat === undefined ? null : Number(body.birthLat);
        const birthLng = body?.birthLng === null || body?.birthLng === undefined ? null : Number(body.birthLng);
        const tzName = body?.tzName ? String(body.tzName).trim() : null;
        const tzOffsetRaw = body?.tzOffsetMinutes === null || body?.tzOffsetMinutes === undefined
          ? null
          : Number(body.tzOffsetMinutes);
        const tzOffsetMinutesRaw = Number.isNaN(tzOffsetRaw as number) ? null : tzOffsetRaw;
        const timeValue = unknownTime ? null : birthTime;
        const tzOffsetComputed = calcTzOffsetMinutes(tzName, birthDate, timeValue, unknownTime);
        const tzOffsetMinutes =
          typeof tzOffsetComputed === "number" ? tzOffsetComputed : tzOffsetMinutesRaw;

        if (!birthDate || !birthPlace) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "missing_fields" }));
          return;
        }
        if (!unknownTime && !birthTime) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "missing_time" }));
          return;
        }
        if (birthLat !== null && Number.isNaN(birthLat)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid_lat" }));
          return;
        }
        if (birthLng !== null && Number.isNaN(birthLng)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid_lng" }));
          return;
        }

        return pool.query(
          `INSERT INTO user_profiles
            (user_id, birth_date, birth_time, unknown_time, birth_place, birth_lat, birth_lng, tz_name, tz_offset_minutes)
           VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (user_id)
           DO UPDATE SET
             birth_date = EXCLUDED.birth_date,
             birth_time = EXCLUDED.birth_time,
             unknown_time = EXCLUDED.unknown_time,
             birth_place = EXCLUDED.birth_place,
             birth_lat = EXCLUDED.birth_lat,
             birth_lng = EXCLUDED.birth_lng,
             tz_name = EXCLUDED.tz_name,
             tz_offset_minutes = EXCLUDED.tz_offset_minutes,
             updated_at = NOW()`,
          [userId, birthDate, timeValue, unknownTime, birthPlace, birthLat, birthLng, tzName, tzOffsetMinutes]
        );
      })
      .then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch((err) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid_payload", details: String(err) }));
      });
    return;
  }
  if (req.url === "/api/profile/report-email" && req.method === "POST") {
    const authHeaders = getAuthentikHeaders(req.headers as Record<string, unknown>);
    const userId = authHeaders["x-authentik-uid"] ?? null;
    const locale = getRequestLocale(req);
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized", message: apiErrorMessage("unauthorized", locale) }));
      return;
    }
    parseJsonBody(req, REPORT_EMAIL_PAYLOAD_MAX_BYTES)
      .then(async (body) => {
        const to = normalizeRecipientEmail(body?.to);
        const reportData = body?.reportData;
        const payloadLocale = String(body?.locale || locale).trim() || locale;
        const reportUrl = normalizeAbsoluteUrl(body?.reportUrl);
        const reportPrintUrl = normalizeAbsoluteUrl(body?.reportPrintUrl);
        const reportHtml = normalizeReportEmailHtml(body?.reportHtml);
        const reportSubject = String(body?.reportSubject || "").replace(/\s+/g, " ").trim();
        const reportHtmlFileName = normalizeReportEmailFilename(body?.reportHtmlFileName);

        if (!to || !isValidEmail(to)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "invalid_email",
              message: localeText(payloadLocale, "Ange en giltig e-postadress.", "Please enter a valid email address."),
            })
          );
          return;
        }
        if (!reportData || typeof reportData !== "object") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "missing_report_data",
              message: localeText(payloadLocale, "Rapportdata saknas.", "Report data is missing."),
            })
          );
          return;
        }

        try {
          const transporter = await getMailTransport();
          const sender = getMailSender();
          const replyTo = String(
            authHeaders["x-authentik-email"] || authHeaders["x-authentik-username"] || ""
          ).trim();
          const email = buildNatalReportEmail({
            data: reportData,
            reportUrl,
            reportPrintUrl,
            locale: payloadLocale,
          });
          const emailPayload = {
            subject: reportSubject || email.subject,
            // Always send a mail-safe preview in body.
            html: email.html,
            text: reportHtml
              ? `${email.text}\n\n${localeText(
                  payloadLocale,
                  "Hela rapporten ligger i den bifogade HTML-filen.",
                  "The full report is in the attached HTML file."
                )}`
              : email.text,
            attachments: reportHtml
              ? [
                  {
                    filename: reportHtmlFileName,
                    content: reportHtml,
                    contentType: "text/html; charset=utf-8",
                  },
                ]
              : undefined,
          };

          await transporter.sendMail({
            from: `"${sender.name.replace(/"/g, '\\"')}" <${sender.address}>`,
            to,
            replyTo: replyTo && isValidEmail(replyTo) ? replyTo : undefined,
            subject: emailPayload.subject,
            html: emailPayload.html,
            text: emailPayload.text,
            attachments: emailPayload.attachments,
          });

          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              message: localeText(
                payloadLocale,
                `Rapporten skickades till ${to}.`,
                `The report was sent to ${to}.`
              ),
            })
          );
        } catch (error) {
          const payload = getReportEmailErrorPayload(error, payloadLocale);
          console.error("[report-email] mail send failed", {
            code: getMailErrorCode(error),
            response: getMailErrorResponse(error),
            message: error instanceof Error ? error.message : String(error),
          });
          res.writeHead(payload.status, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: payload.error,
              message: payload.message,
              details: payload.details,
            })
          );
        }
      })
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isTooLarge = errorMessage.includes("payload_too_large");
        res.writeHead(isTooLarge ? 413 : 400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: isTooLarge ? "payload_too_large" : "invalid_payload",
            message: isTooLarge
              ? localeText(
                  locale,
                  "Fullrapporten blev för stor att skicka i ett enda mejl. Försök igen eller minska mängden inbäddade bilder.",
                  "The full report became too large to send in a single email. Please try again or reduce embedded images."
                )
              : localeText(locale, "Ogiltig förfrågan.", "Invalid request."),
            details: String(error),
          })
        );
      });
    return;
  }
  if (req.url === "/api/membership" && req.method === "GET") {
    const authHeaders = getAuthentikHeaders(req.headers as Record<string, unknown>);
    const userId = authHeaders["x-authentik-uid"] ?? null;
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    (async () => {
      try {
        const membership = await syncMembershipIdentity(userId, authHeaders);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            membership,
            paywall: { aiUnlocked: membershipHasAiAccess(membership) },
          })
        );
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "membership_fetch_failed", details: String(err) }));
      }
    })();
    return;
  }
  if (req.url === "/api/membership/redeem" && req.method === "POST") {
    const locale = getRequestLocale(req);
    const authHeaders = getAuthentikHeaders(req.headers as Record<string, unknown>);
    const userId = authHeaders["x-authentik-uid"] ?? null;
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized", message: apiErrorMessage("unauthorized", locale) }));
      return;
    }
    (async () => {
      try {
        await syncMembershipIdentity(userId, authHeaders);
        const currentMembership = await getMembershipRow(userId);
        if (membershipHasAiAccess(currentMembership)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, membership: currentMembership, alreadyActive: true }));
          return;
        }
        const body = await parseJsonBody(req);
        const code = normalizeMembershipCode(body?.code);
        if (!code) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "membership_code_invalid",
              message: apiErrorMessage("membership_code_invalid", locale),
            })
          );
          return;
        }
        const updatedCode = await pool.query(
          `UPDATE membership_registration_codes
           SET use_count = use_count + 1,
               updated_at = NOW()
           WHERE code = $1
             AND active = TRUE
             AND (expires_at IS NULL OR expires_at > NOW())
             AND (max_uses IS NULL OR use_count < max_uses)
           RETURNING code, grants_tier, grants_ai`,
          [code]
        );
        if (!updatedCode.rowCount) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "membership_code_invalid",
              message: apiErrorMessage("membership_code_invalid", locale),
            })
          );
          return;
        }
        const granted = updatedCode.rows[0];
        await pool.query(
          `INSERT INTO user_memberships (user_id, username, display_name, email, active, tier, ai_access, registration_code, joined_at)
           SELECT user_id, username, display_name, email, TRUE, $2, $3, $4, NOW()
           FROM user_memberships
           WHERE user_id = $1
           ON CONFLICT (user_id)
           DO UPDATE SET
             active = TRUE,
             tier = EXCLUDED.tier,
             ai_access = EXCLUDED.ai_access,
             registration_code = EXCLUDED.registration_code,
             joined_at = COALESCE(user_memberships.joined_at, NOW()),
             updated_at = NOW()`,
          [userId, granted.grants_tier || "member", Boolean(granted.grants_ai), code]
        );
        const membership = await getMembershipRow(userId);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, membership, redeemed: code }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "membership_redeem_failed", details: String(err) }));
      }
    })();
    return;
  }
  if (req.url === "/api/friends" && req.method === "GET") {
    const locale = getRequestLocale(req);
    const authHeaders = getAuthentikHeaders(req.headers as Record<string, unknown>);
    const userId = authHeaders["x-authentik-uid"] ?? null;
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized", message: apiErrorMessage("unauthorized", locale) }));
      return;
    }
    (async () => {
      try {
        await syncMembershipIdentity(userId, authHeaders);
        const membership = await getMembershipRow(userId);
        if (!membership?.active) {
          res.writeHead(402, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "membership_required", message: apiErrorMessage("membership_required", locale) }));
          return;
        }
        const result = await pool.query(
          `SELECT
             CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END AS user_id,
             CASE
               WHEN f.status = 'accepted' THEN 'accepted'
               WHEN f.requester_id = $1 THEN 'outgoing'
               ELSE 'incoming'
             END AS direction,
             f.status,
             f.created_at,
             f.responded_at,
             um.username,
             um.display_name,
             um.active,
             um.tier,
             um.ai_access
           FROM user_friendships f
           JOIN user_memberships um
             ON um.user_id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
           WHERE f.requester_id = $1 OR f.addressee_id = $1
           ORDER BY COALESCE(f.responded_at, f.created_at) DESC`,
          [userId]
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            friends: {
              accepted: result.rows.filter((row) => row.status === "accepted"),
              incoming: result.rows.filter((row) => row.status === "pending" && row.direction === "incoming"),
              outgoing: result.rows.filter((row) => row.status === "pending" && row.direction === "outgoing"),
            },
          })
        );
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "friends_fetch_failed", details: String(err) }));
      }
    })();
    return;
  }
  if (req.url?.startsWith("/api/friends/search") && req.method === "GET") {
    const locale = getRequestLocale(req);
    const authHeaders = getAuthentikHeaders(req.headers as Record<string, unknown>);
    const userId = authHeaders["x-authentik-uid"] ?? null;
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized", message: apiErrorMessage("unauthorized", locale) }));
      return;
    }
    (async () => {
      try {
        await syncMembershipIdentity(userId, authHeaders);
        const membership = await getMembershipRow(userId);
        if (!membership?.active) {
          res.writeHead(402, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "membership_required", message: apiErrorMessage("membership_required", locale) }));
          return;
        }
        const requestUrl = new URL(req.url || "/", "http://localhost");
        const q = String(requestUrl.searchParams.get("q") || "").trim();
        if (q.length < 2) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, results: [] }));
          return;
        }
        const result = await pool.query(
          `WITH searchable_users AS (
             SELECT
               COALESCE(NULLIF(u.external_id, ''), um.user_id) AS user_id,
               COALESCE(NULLIF(um.username, ''), NULLIF(u.username, '')) AS username,
               COALESCE(NULLIF(um.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, '')) AS display_name,
               COALESCE(um.active, FALSE) AS active,
               COALESCE(um.tier, 'free') AS tier,
               COALESCE(um.ai_access, FALSE) AS ai_access
             FROM public.users u
             LEFT JOIN user_memberships um
               ON um.user_id = u.external_id
             WHERE u.provider = 'authentik'
               AND COALESCE(NULLIF(u.external_id, ''), '') <> ''

             UNION ALL

             SELECT
               um.user_id,
               um.username,
               um.display_name,
               um.active,
               um.tier,
               um.ai_access
             FROM user_memberships um
             WHERE NOT EXISTS (
               SELECT 1
               FROM public.users u
               WHERE u.provider = 'authentik'
                 AND u.external_id = um.user_id
             )
           )
           SELECT
             su.user_id,
             su.username,
             su.display_name,
             su.active,
             su.tier,
             su.ai_access,
             CASE
               WHEN f.status = 'accepted' THEN 'accepted'
               WHEN f.requester_id = $1 THEN 'outgoing'
               WHEN f.addressee_id = $1 THEN 'incoming'
               ELSE 'none'
             END AS relation
           FROM searchable_users su
           LEFT JOIN user_friendships f
             ON (
               (f.requester_id = $1 AND f.addressee_id = su.user_id)
               OR
               (f.requester_id = su.user_id AND f.addressee_id = $1)
             )
           WHERE su.user_id <> $1
             AND (
               COALESCE(su.username, '') ILIKE $2
               OR
               COALESCE(su.display_name, '') ILIKE $2
               OR
               su.user_id ILIKE $2
             )
           ORDER BY su.active DESC, COALESCE(su.display_name, su.username, su.user_id)
           LIMIT 10`,
          [userId, `%${q}%`]
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, results: result.rows }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "friends_search_failed", details: String(err) }));
      }
    })();
    return;
  }
  if (req.url === "/api/friends/request" && req.method === "POST") {
    const locale = getRequestLocale(req);
    const authHeaders = getAuthentikHeaders(req.headers as Record<string, unknown>);
    const userId = authHeaders["x-authentik-uid"] ?? null;
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized", message: apiErrorMessage("unauthorized", locale) }));
      return;
    }
    (async () => {
      try {
        await syncMembershipIdentity(userId, authHeaders);
        const membership = await getMembershipRow(userId);
        if (!membership?.active) {
          res.writeHead(402, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "membership_required", message: apiErrorMessage("membership_required", locale) }));
          return;
        }
        const body = await parseJsonBody(req);
        const targetUserId = String(body?.targetUserId || "").trim();
        if (!targetUserId || targetUserId === userId) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid_target" }));
          return;
        }
        const targetMembership = await ensureMembershipRecordForUser(targetUserId);
        if (!targetMembership) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "target_missing" }));
          return;
        }
        if (await areAcceptedFriends(userId, targetUserId)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, status: "accepted" }));
          return;
        }
        const reversed = await pool.query(
          `UPDATE user_friendships
           SET status = 'accepted',
               responded_at = NOW(),
               updated_at = NOW()
           WHERE requester_id = $1
             AND addressee_id = $2
             AND status = 'pending'
           RETURNING requester_id`,
          [targetUserId, userId]
        );
        if (reversed.rowCount) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, status: "accepted" }));
          return;
        }
        const existingPending = await pool.query(
          `SELECT 1
           FROM user_friendships
           WHERE requester_id = $1
             AND addressee_id = $2
             AND status = 'pending'`,
          [userId, targetUserId]
        );
        if (existingPending.rowCount) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, status: "pending" }));
          return;
        }
        await pool.query(
          `INSERT INTO user_friendships (requester_id, addressee_id, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (requester_id, addressee_id)
           DO UPDATE SET
             status = 'pending',
             responded_at = NULL,
             updated_at = NOW()`,
          [userId, targetUserId]
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, status: "pending" }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "friend_request_failed", details: String(err) }));
      }
    })();
    return;
  }
  if (req.url === "/api/friends/respond" && req.method === "POST") {
    const locale = getRequestLocale(req);
    const authHeaders = getAuthentikHeaders(req.headers as Record<string, unknown>);
    const userId = authHeaders["x-authentik-uid"] ?? null;
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized", message: apiErrorMessage("unauthorized", locale) }));
      return;
    }
    (async () => {
      try {
        await syncMembershipIdentity(userId, authHeaders);
        const membership = await getMembershipRow(userId);
        if (!membership?.active) {
          res.writeHead(402, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "membership_required", message: apiErrorMessage("membership_required", locale) }));
          return;
        }
        const body = await parseJsonBody(req);
        const requesterUserId = String(body?.requesterUserId || "").trim();
        const action = String(body?.action || "").trim().toLowerCase();
        if (!requesterUserId || (action !== "accept" && action !== "decline")) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid_payload" }));
          return;
        }
        const nextStatus = action === "accept" ? "accepted" : "declined";
        const result = await pool.query(
          `UPDATE user_friendships
           SET status = $3,
               responded_at = NOW(),
               updated_at = NOW()
           WHERE requester_id = $1
             AND addressee_id = $2
             AND status = 'pending'
           RETURNING requester_id, addressee_id, status`,
          [requesterUserId, userId, nextStatus]
        );
        if (!result.rowCount) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "friend_request_missing" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, status: nextStatus }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "friend_respond_failed", details: String(err) }));
      }
    })();
    return;
  }
  if (req.url === "/api/friends/remove" && req.method === "POST") {
    const locale = getRequestLocale(req);
    const authHeaders = getAuthentikHeaders(req.headers as Record<string, unknown>);
    const userId = authHeaders["x-authentik-uid"] ?? null;
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized", message: apiErrorMessage("unauthorized", locale) }));
      return;
    }
    (async () => {
      try {
        await syncMembershipIdentity(userId, authHeaders);
        const membership = await getMembershipRow(userId);
        if (!membership?.active) {
          res.writeHead(402, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "membership_required", message: apiErrorMessage("membership_required", locale) }));
          return;
        }
        const body = await parseJsonBody(req);
        const targetUserId = String(body?.targetUserId || "").trim();
        if (!targetUserId) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid_target" }));
          return;
        }
        await pool.query(
          `DELETE FROM user_friendships
           WHERE (requester_id = $1 AND addressee_id = $2)
              OR (requester_id = $2 AND addressee_id = $1)`,
          [userId, targetUserId]
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "friend_remove_failed", details: String(err) }));
      }
    })();
    return;
  }
  if (req.url === "/api/friends/compatibility/email" && req.method === "POST") {
    const locale = getRequestLocale(req);
    const authHeaders = getAuthentikHeaders(req.headers as Record<string, unknown>);
    const userId = authHeaders["x-authentik-uid"] ?? null;
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized", message: apiErrorMessage("unauthorized", locale) }));
      return;
    }
    parseJsonBody(req, 200_000)
      .then(async (body) => {
        const payloadLocale = String(body?.locale || locale).trim() || locale;
        const targetUserId = String(body?.targetUserId || "").trim();
        const reportUrl = normalizeAbsoluteUrl(body?.reportUrl);
        if (!targetUserId) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "missing_user_id",
              message: localeText(payloadLocale, "Vän saknas för jämförelsen.", "Missing friend for the reading."),
            })
          );
          return;
        }

        const context = await loadCompatibilityContext({
          userId,
          targetUserId,
          authHeaders,
          locale: payloadLocale,
        });
        if (!context.ok) {
          res.writeHead(context.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: context.error, message: context.message }));
          return;
        }

        const sharedUser = await ensureSharedUserRecord(authHeaders, null);
        const to = normalizeRecipientEmail(
          body?.to || sharedUser?.email || context.membership?.email || authHeaders["x-authentik-email"] || ""
        );
        if (!to || !isValidEmail(to)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "invalid_email",
              message: localeText(
                payloadLocale,
                "Lägg till en giltig e-postadress på din profil först.",
                "Please add a valid email address to your profile first."
              ),
            })
          );
          return;
        }

        try {
          const transporter = await getMailTransport();
          const sender = getMailSender();
          const replyTo = String(authHeaders["x-authentik-email"] || sharedUser?.email || "").trim();
          const compatibility = {
            ...context.report,
            friend: context.friendIdentity,
          };
          const email = buildCompatibilityEmail({
            compatibility,
            locale: payloadLocale,
            reportUrl,
            displayNames: context.displayNames,
          });

          await transporter.sendMail({
            from: `"${sender.name.replace(/"/g, '\\"')}" <${sender.address}>`,
            to,
            replyTo: replyTo && isValidEmail(replyTo) ? replyTo : undefined,
            subject: email.subject,
            html: email.html,
            text: `${email.text}\n\n${localeText(
              payloadLocale,
              "Hela djupjämförelsen finns i den bifogade HTML-filen.",
              "The full deep reading is in the attached HTML file."
            )}`,
            attachments: [
              {
                filename: email.attachmentFileName,
                content: email.attachmentHtml,
                contentType: "text/html; charset=utf-8",
              },
            ],
          });

          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              message: localeText(
                payloadLocale,
                `Horoskopjämförelsen skickades till ${to}.`,
                `The compatibility reading was sent to ${to}.`
              ),
            })
          );
        } catch (error) {
          const payload = getReportEmailErrorPayload(error, payloadLocale);
          console.error("[compatibility-email] mail send failed", {
            code: getMailErrorCode(error),
            response: getMailErrorResponse(error),
            message: error instanceof Error ? error.message : String(error),
          });
          res.writeHead(payload.status, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: payload.error,
              message: payload.message,
              details: payload.details,
            })
          );
        }
      })
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isTooLarge = errorMessage.includes("payload_too_large");
        res.writeHead(isTooLarge ? 413 : 400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: isTooLarge ? "payload_too_large" : "invalid_payload",
            message: isTooLarge
              ? localeText(
                  locale,
                  "Jämförelsemejlet blev för stort. Försök igen.",
                  "The compatibility email became too large. Please try again."
                )
              : localeText(locale, "Ogiltig förfrågan.", "Invalid request."),
            details: String(error),
          })
        );
      });
    return;
  }
  if (req.url?.startsWith("/api/friends/compatibility/") && req.method === "GET") {
    const locale = getRequestLocale(req);
    const authHeaders = getAuthentikHeaders(req.headers as Record<string, unknown>);
    const userId = authHeaders["x-authentik-uid"] ?? null;
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized", message: apiErrorMessage("unauthorized", locale) }));
      return;
    }
    (async () => {
      try {
        const requestUrl = new URL(req.url || "/", "http://localhost");
        const parts = requestUrl.pathname.split("/").filter(Boolean);
        const targetUserId = parts[parts.length - 1];
        if (!targetUserId) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "missing_user_id" }));
          return;
        }
        const context = await loadCompatibilityContext({
          userId,
          targetUserId,
          authHeaders,
          locale,
        });
        if (!context.ok) {
          res.writeHead(context.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: context.error, message: context.message }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            compatibility: {
              ...context.report,
              friend: context.friendIdentity,
            },
          })
        );
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "compatibility_failed", details: String(err) }));
      }
    })();
    return;
  }
  if (req.url?.startsWith("/api/profile/avatar") && req.method === "GET") {
    const authHeaders = getAuthentikHeaders(req.headers as Record<string, unknown>);
    const userId = authHeaders["x-authentik-uid"] ?? null;
    const username = authHeaders["x-authentik-username"] ?? null;
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    (async () => {
      try {
        const dbAvatar = await loadAvatarFromDbCandidates(await resolveSharedAvatarCandidates(userId, username));
        if (dbAvatar) {
          res.writeHead(200, {
            "content-type": dbAvatar.mimeType,
            "cache-control": "private, no-store",
          });
          res.end(dbAvatar.buffer);
          return;
        }
        const fallbackAvatar =
          (await loadAvatarFallbackForUsername(username)) ||
          (await loadDefaultAvatarFallback());
        if (!fallbackAvatar) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "avatar_missing" }));
          return;
        }
        res.writeHead(200, {
          "content-type": fallbackAvatar.mimeType,
          "cache-control": "public, max-age=300",
        });
        res.end(fallbackAvatar.buffer);
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "avatar_fetch_failed", details: String(err) }));
      }
    })();
    return;
  }
  if (req.url === "/api/profile/avatar" && req.method === "POST") {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    (async () => {
      try {
        const body = await parseJsonBody(req, AVATAR_UPLOAD_PAYLOAD_MAX_BYTES);
        const imageDataUrl = String(body?.imageDataUrl || "").trim();
        const requestedStyle = String(body?.style || "plain")
          .trim()
          .toLowerCase();
        if (styleLooksLikeGta(requestedStyle)) {
          const membership = await getMembershipRow(userId);
          if (!membershipHasAiAccess(membership)) {
            res.writeHead(402, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: "membership_required",
                message: apiErrorMessage("membership_required", getRequestLocale(req)),
              })
            );
            return;
          }
        }
        if (!imageDataUrl) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "missing_image" }));
          return;
        }
        const parsed = parseImageDataUrl(imageDataUrl);
        if (!parsed) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid_image_data" }));
          return;
        }
        if (parsed.buffer.length > AVATAR_UPLOAD_MAX_BYTES) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "image_too_large" }));
          return;
        }

        const normalizedSource = await sharp(parsed.buffer, { failOn: "none" })
          .rotate()
          .resize(1024, 1024, { fit: "cover", position: "attention" })
          .png()
          .toBuffer();

        const styledSource = styleLooksLikeGta(requestedStyle)
          ? await stylizeAvatarGta(normalizedSource)
          : normalizedSource;

        const avatarBuffer = await sharp(styledSource, { failOn: "none" })
          .rotate()
          .resize(512, 512, { fit: "cover", position: "attention" })
          .jpeg({ quality: 86, mozjpeg: true })
          .toBuffer();

        await ensureUserAvatarsTable();
        await pool.query(
          `INSERT INTO public.user_avatars (user_id, avatar_mime_type, avatar_data)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id)
           DO UPDATE SET
             avatar_mime_type = EXCLUDED.avatar_mime_type,
             avatar_data = EXCLUDED.avatar_data,
             updated_at = NOW()`,
          [userId, "image/jpeg", avatarBuffer]
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, style: requestedStyle }));
      } catch (err) {
        const errorCode = (err as Error)?.message === "payload_too_large" ? "image_too_large" : "avatar_upload_failed";
        const status = errorCode === "image_too_large" ? 413 : 500;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: errorCode, details: String(err) }));
      }
    })();
    return;
  }
  if (req.url?.startsWith("/api/places") && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 2) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, results: [] }));
      return;
    }
    const ua = (process.env.PLACES_USER_AGENT || "chkn/1.0").trim();
    fetch(
      `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`,
      {
        headers: { "User-Agent": ua },
      }
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`nominatim_${r.status}`);
        return r.json();
      })
      .then((data) => {
        const results = Array.isArray(data)
          ? data.map((item: any) => ({
              id: String(item.place_id || ""),
              name: String(item.display_name || "").trim(),
              lat: item.lat ? Number(item.lat) : null,
              lng: item.lon ? Number(item.lon) : null,
            }))
          : [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, results }));
      })
      .catch((err) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "places_failed", details: String(err) }));
      });
    return;
  }
  if (req.url === "/api/chart" && req.method === "GET") {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    pool
      .query(
        `SELECT chart_id, input_json, result_json, created_at
         FROM birth_charts
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId]
      )
      .then((result) => {
        const row = result.rowCount ? result.rows[0] : null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, chart: row }));
      })
      .catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "db_error", details: String(err) }));
      });
    return;
  }
  if (req.url === "/api/chart/calc" && req.method === "POST") {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    pool
      .query(
        `SELECT birth_date::text as birth_date, birth_time::text as birth_time, unknown_time, birth_place, birth_lat, birth_lng, tz_name, tz_offset_minutes
         FROM user_profiles
         WHERE user_id = $1`,
        [userId]
      )
      .then(async (result) => {
        if (!result.rowCount) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "missing_profile" }));
          return null;
        }
        const profile = result.rows[0] as ProfileRow;
        if (!profile.birth_date || !profile.birth_place) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "missing_profile_fields" }));
          return null;
        }
        if (profile.birth_lat === null || profile.birth_lng === null) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "missing_coordinates" }));
          return null;
        }
        const chart = await computeBirthChart(profile);
        await pool.query(
          `INSERT INTO birth_charts (user_id, input_json, result_json)
           VALUES ($1, $2, $3)`,
          [userId, chart.input, chart]
        );
        return chart;
      })
      .then((chart) => {
        if (!chart) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, chart }));
      })
      .catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "calc_failed", details: String(err) }));
      });
    return;
  }
  if (req.url === "/api/profile/insights" && req.method === "GET") {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    pool
      .query(
        `SELECT insight_id, summary_json, astrology_json, human_design_json, created_at
         FROM profile_insights
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId]
      )
      .then((result) => {
        const row = result.rowCount ? result.rows[0] : null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, insights: row }));
      })
      .catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "db_error", details: String(err) }));
      });
    return;
  }
  if (req.url?.startsWith("/api/tarot/major-arcana") && req.method === "GET") {
    const locale = getRequestLocale(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, cards: getTarotMajorArcana(locale) }));
    return;
  }
  if (req.url === "/api/tarot/oracle" && req.method === "POST") {
    const locale = getRequestLocale(req);
    const userId = getUserIdFromReq(req);
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized", message: apiErrorMessage("unauthorized", locale) }));
      return;
    }
    (async () => {
      const membership = await getMembershipRow(userId);
      if (!membershipHasAiAccess(membership)) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "membership_required",
            message: apiErrorMessage("membership_required", locale),
          })
        );
        return;
      }
      const body = await parseJsonBody(req);
        const language = String(body?.language || "").trim() || "en-US";
        const spreadLabel =
          String(body?.spreadLabel || "").trim() ||
          localeText(language, "Tarotläggning", "Tarot reading");
        const spreadDescription = String(body?.spreadDescription || "").trim();
        const message = String(body?.message || "").trim();
        const answers = Array.isArray(body?.answers)
          ? body.answers.map((v: unknown) => String(v || "").trim()).filter(Boolean).slice(0, 20)
          : [];
        const cards = Array.isArray(body?.cards)
          ? body.cards
              .map((c: any) => ({
                slot: String(c?.slot || "").trim(),
                name: String(c?.name || "").trim(),
                orientation: c?.orientation === "reversed" ? "reversed" : "upright",
                summary: String(c?.summary || "").trim(),
                upright: String(c?.upright || "").trim(),
                reversed: String(c?.reversed || "").trim(),
              }))
              .filter((c: { slot: string; name: string }) => c.slot && c.name)
              .slice(0, 12)
          : [];
        const conversation = Array.isArray(body?.conversation)
          ? body.conversation
              .map((m: any) => ({
                role: m?.role === "assistant" ? "assistant" : "user",
                text: String(m?.text || "").trim(),
              }))
              .filter((m: { text: string }) => Boolean(m.text))
              .slice(-20)
          : [];
        const profileContext = body?.profileContext && typeof body.profileContext === "object"
          ? body.profileContext
          : null;
        const responseLocale = language || locale;
        if (!message) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "missing_message",
              message: apiErrorMessage("missing_message", responseLocale),
            })
          );
          return;
        }
        let reply = "";
        try {
          reply = await requestOracleReply({
            spreadLabel,
            spreadDescription,
            language,
            message,
            answers,
            cards,
            profileContext,
            conversation: conversation as Array<{ role: "user" | "assistant"; text: string }>,
          });
        } catch {
          reply = fallbackOracleReply(
            spreadLabel,
            message,
            cards.map((c: { slot: string; name: string; orientation: "upright" | "reversed" }) => ({
              slot: c.slot,
              name: c.name,
              orientation: c.orientation,
            })),
            language
          );
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, reply }));
    })().catch((err) => {
      const locale = getRequestLocale(req);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: "oracle_failed",
          message: apiErrorMessage("oracle_failed", locale),
          details: String(err),
        })
      );
    });
    return;
  }
  if (req.url?.startsWith("/api/profile/tarot/daily") && req.method === "GET") {
    const locale = getRequestLocale(req);
    const userId = getUserIdFromReq(req);
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized", message: apiErrorMessage("unauthorized", locale) }));
      return;
    }
    const now = new Date();
    pool
      .query(
        `SELECT tz_name
         FROM user_profiles
         WHERE user_id = $1`,
        [userId]
      )
      .then(async (tzResult) => {
        const tzName = (tzResult.rowCount ? String(tzResult.rows[0].tz_name || "") : "").trim() || "UTC";
        const dateKey = getTarotDateKey(now, tzName);
        const existingResult = await pool.query(
          `SELECT user_id, draw_date::text as draw_date, card_number, card_name, orientation, image_url, summary,
                  upright_meaning, reversed_meaning, more_info_url, drawn_at, expires_at
           FROM user_tarot_daily
           WHERE user_id = $1 AND draw_date = $2`,
          [userId, dateKey]
        );
        const existing = existingResult.rowCount ? existingResult.rows[0] : null;
        if (existing && new Date(existing.expires_at).getTime() > now.getTime()) {
          return { draw: existing, created: false };
        }

        const nextExpiresAt = getTarotExpiresAt(now, tzName);
        const { card, orientation } = drawDailyTarotCard();
        const upsertResult = await pool.query(
          `INSERT INTO user_tarot_daily
            (user_id, draw_date, card_number, card_name, orientation, image_url, summary, upright_meaning, reversed_meaning, more_info_url, drawn_at, expires_at)
           VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11)
           ON CONFLICT (user_id, draw_date)
           DO UPDATE SET
             card_number = EXCLUDED.card_number,
             card_name = EXCLUDED.card_name,
             orientation = EXCLUDED.orientation,
             image_url = EXCLUDED.image_url,
             summary = EXCLUDED.summary,
             upright_meaning = EXCLUDED.upright_meaning,
             reversed_meaning = EXCLUDED.reversed_meaning,
             more_info_url = EXCLUDED.more_info_url,
             drawn_at = NOW(),
             expires_at = EXCLUDED.expires_at,
             updated_at = NOW()
           RETURNING user_id, draw_date::text as draw_date, card_number, card_name, orientation, image_url, summary,
                     upright_meaning, reversed_meaning, more_info_url, drawn_at, expires_at`,
          [
            userId,
            dateKey,
            card.number,
            card.name,
            orientation,
            card.imageUrl,
            card.summary,
            card.upright,
            card.reversed,
            card.moreInfoUrl,
            nextExpiresAt.toISOString(),
          ]
        );
        return { draw: upsertResult.rows[0], created: true };
      })
      .then((result) => {
        if (!result) return;
        const localizedDraw = localizeTarotDailyDrawRow(result.draw, locale);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, draw: localizedDraw, created: result.created }));
      })
      .catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "tarot_daily_failed",
            message: apiErrorMessage("tarot_daily_failed", locale),
            details: String(err),
          })
        );
      });
    return;
  }
  if (req.url?.startsWith("/api/profile/insights/") && req.method === "GET") {
    const authUserId = getUserIdFromReq(req);
    const locale = getRequestLocale(req);
    if (!authUserId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    const parts = req.url.split("/").filter(Boolean);
    const requestedId = parts[parts.length - 1];
    if (!requestedId) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "missing_user_id" }));
      return;
    }
    (async () => {
      if (!(await canAccessProfilePayload(authUserId, requestedId))) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "friendship_required", message: apiErrorMessage("friendship_required", locale) }));
        return;
      }
      const result = await pool.query(
        `SELECT insight_id, summary_json, astrology_json, human_design_json, created_at
         FROM profile_insights
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [requestedId]
      );
      const row = result.rowCount ? result.rows[0] : null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, insights: row }));
    })().catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "db_error", details: String(err) }));
    });
    return;
  }
  if (req.url?.startsWith("/api/profile/") && req.method === "GET") {
    const authUserId = getUserIdFromReq(req);
    const locale = getRequestLocale(req);
    if (!authUserId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    const parts = req.url.split("/").filter(Boolean);
    const requestedId = parts[parts.length - 1];
    if (!requestedId || requestedId === "profile") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "missing_user_id" }));
      return;
    }
    (async () => {
      if (!(await canAccessProfilePayload(authUserId, requestedId))) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "friendship_required", message: apiErrorMessage("friendship_required", locale) }));
        return;
      }
      const result = await pool.query(
        `SELECT user_id, birth_date::text as birth_date, birth_time::text as birth_time, unknown_time, birth_place, birth_lat, birth_lng, tz_name, tz_offset_minutes
         FROM user_profiles
         WHERE user_id = $1`,
        [requestedId]
      );
      const row = result.rowCount ? result.rows[0] : null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, profile: row }));
    })().catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "db_error", details: String(err) }));
    });
    return;
  }
  if (req.url === "/api/profile/insights/calc" && req.method === "POST") {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    pool
      .query(
        `SELECT birth_date::text as birth_date, birth_time::text as birth_time, unknown_time, birth_place, birth_lat, birth_lng, tz_name, tz_offset_minutes
         FROM user_profiles
         WHERE user_id = $1`,
        [userId]
      )
      .then(async (result) => {
        if (!result.rowCount) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "missing_profile" }));
          return null;
        }
        const profile = result.rows[0] as ProfileRow;
        const insights = await computeProfileInsights(profile);
        await pool.query(
          `INSERT INTO profile_insights (user_id, summary_json, astrology_json, human_design_json)
           VALUES ($1, $2, $3, $4)`,
          [userId, insights.summary, insights.astrology, insights.human_design]
        );
        return insights;
      })
      .then((insights) => {
        if (!insights) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, insights }));
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("insights_failed", err?.stack || err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "insights_failed", details: String(err) }));
      });
    return;
  }
  res.writeHead(404);
  res.end();
});
const io = new Server(server, {
  cors: { origin: "*" },
});

io.engine.on("connection_error", (err) => {
  // eslint-disable-next-line no-console
  console.log("engine connection_error", err.code, err.message);
});

const emitEvent = async (
  matchId: string,
  type: string,
  payload: unknown,
  options?: { persist?: boolean }
) => {
  io.to(matchId).emit("event", { type, payload });
  if (options?.persist === false) return;
  const runtime = getMatchRuntime(matchId);
  if (!runtime) return;
  await persistServerEvent(runtime, matchId, type, payload);
};

const emitMatchState = async (matchId: string, runtime: MatchRuntime) => {
  const ctx = runtime.orchestrator.getContext();
  await emitEvent(matchId, "MATCH_STATE", {
    matchId,
    mode: ctx.match.mode,
    players: ctx.players.map((p) => ({ userId: p.userId, stack: p.stack })),
    readyUserIds: Array.from(runtime.ready),
    stage: ctx.stage,
    status: ctx.status,
    hostUserId: runtime.hostUserId,
    yatzyMatchId: runtime.yatzyMatchId,
    blackjackRound: runtime.blackjack?.roundState?.round ?? null,
  }, { persist: false });
  await saveRedisOnly(runtime);
};

const getMatchRuntime = (matchId: string): MatchRuntime | null => {
  return matches.get(matchId) ?? null;
};

const applyServerEventToState = (
  state: PersistedMatchState,
  type: string,
  payload: any
): PersistedMatchState => {
  const next = { ...state, players: [...state.players], ledger: [...state.ledger] };
  switch (type) {
    case "MATCH_CREATED":
      if (payload?.match) next.match = payload.match;
      return next;
    case "MATCH_JOINED":
      if (payload?.userId && !next.players.some((p) => p.userId === payload.userId)) {
        next.players.push({
          matchId: next.match.id,
          userId: payload.userId,
          seat: next.players.length + 1,
          stack: 0,
          isConnected: true,
          isBot: false,
        });
      }
      return next;
    case "MATCH_LEFT":
      if (payload?.userId) {
        const p = next.players.find((pl) => pl.userId === payload.userId);
        if (p) p.isConnected = false;
      }
      return next;
    case "READY_CHECK_PASSED":
      next.status = "RUNNING";
      next.match = { ...next.match, status: "RUNNING" };
      return next;
    case "STAGE_STARTED":
      if (payload?.stage) next.stage = payload.stage;
      return next;
    case "LEDGER_ENTRY_APPLIED":
      if (payload?.entry) {
        next.ledger.push(payload.entry);
        const p = next.players.find((pl) => pl.userId === payload.entry.userId);
        if (p) p.stack += payload.entry.delta;
      }
      return next;
    case "STACK_UPDATED":
      if (payload?.userId && typeof payload?.stack === "number") {
        const p = next.players.find((pl) => pl.userId === payload.userId);
        if (p) p.stack = payload.stack;
      }
      return next;
    case "YATZY_MATCH_SET":
    case "YATZY_MATCH_CREATED":
      if (payload?.yatzyMatchId) next.yatzyMatchId = payload.yatzyMatchId;
      return next;
    default:
      return next;
  }
};

const recoverMatch = async (matchId: string): Promise<MatchRuntime | null> => {
  let state: PersistedMatchState | null = null;
  state = await safeRedisValue(() => loadRedisState(matchId), null);
  if (!state) {
    state = await safeDbValue(() => loadSnapshotFromDb(matchId), null);
  }
  if (!state) return null;

  const events = await safeDbValue(() => loadEventsAfterSeq(matchId, state!.seq), []);
  let rebuilt = state;
  for (const ev of events as Array<{ seq: number; type: string; payload: any }>) {
    if (ev?.payload?.source !== "server") {
      rebuilt = { ...rebuilt, seq: ev.seq };
      continue;
    }
    const serverPayload = { ...ev.payload };
    delete serverPayload.source;
    rebuilt = applyServerEventToState(rebuilt, ev.type, serverPayload);
    rebuilt.seq = ev.seq;
  }

  const ctx = {
    match: rebuilt.match,
    players: rebuilt.players,
    stage: rebuilt.stage,
    status: rebuilt.status,
  };
  const orchestrator = new MatchOrchestrator(ctx);
  const runtime: MatchRuntime = {
    orchestrator,
    ready: new Set(rebuilt.readyUserIds),
    ledger: rebuilt.ledger,
    yatzySubmissions: new Map(rebuilt.yatzySubmissions),
    yatzyMatchId: rebuilt.yatzyMatchId,
    hostUserId: rebuilt.hostUserId,
    hostAuthHeaders: {},
    yatzyAuthToken: null,
    blackjack: rebuilt.blackjack ?? null,
    seq: rebuilt.seq,
  };
  matches.set(matchId, runtime);
  await saveSnapshotNow(runtime);
  return runtime;
};

const createPlayer = (matchId: string, userId: string, seat: number): MatchPlayer => ({
  matchId,
  userId,
  seat,
  stack: 0,
  isConnected: true,
  isBot: false,
});

const createMatch = (mode: MatchMode, userId: string): { match: Match; runtime: MatchRuntime } => {
  const matchId = randomUUID();
  const match: Match = {
    id: matchId,
    mode,
    status: "CREATED",
    createdAt: Date.now(),
  };
  const players: MatchPlayer[] = [createPlayer(matchId, userId, 1)];
  const ctx = { match, players, stage: "LOBBY" as Stage, status: "CREATED" as MatchStatus };
  const orchestrator = new MatchOrchestrator(ctx);
  const runtime: MatchRuntime = {
    orchestrator,
    ready: new Set(),
    ledger: [],
    yatzySubmissions: new Map(),
    yatzyMatchId: null,
    hostUserId: userId,
    hostAuthHeaders: {},
    yatzyAuthToken: null,
    blackjack: null,
    seq: 0,
  };
  matches.set(matchId, runtime);
  return { match, runtime };
};

const joinMatch = (runtime: MatchRuntime, matchId: string, userId: string) => {
  const ctx = runtime.orchestrator.getContext();
  if (ctx.players.some((p) => p.userId === userId)) return;
  if (ctx.players.length >= 6) return;
  const seat = ctx.players.length + 1;
  ctx.players.push(createPlayer(matchId, userId, seat));
};

const setMatchStatus = (runtime: MatchRuntime, status: MatchStatus) => {
  const ctx = runtime.orchestrator.getContext();
  ctx.status = status;
  ctx.match.status = status;
  safeDb(() => updateMatchStatus(ctx.match.id, status));
};

const applyLedgerEntry = async (runtime: MatchRuntime, entry: LedgerEntry) => {
  const ctx = runtime.orchestrator.getContext();
  const player = ctx.players.find((p) => p.userId === entry.userId);
  if (!player) return;
  player.stack += entry.delta;
  runtime.ledger.push(entry);
  await emitEvent(entry.matchId, "LEDGER_ENTRY_APPLIED", { entry });
  await emitEvent(entry.matchId, "STACK_UPDATED", { matchId: entry.matchId, userId: entry.userId, stack: player.stack });
};

const applyAbsoluteStack = async (runtime: MatchRuntime, matchId: string, userId: string, stack: number, stage: Stage, reason: string) => {
  const ctx = runtime.orchestrator.getContext();
  const player = ctx.players.find((p) => p.userId === userId);
  if (!player) return;
  const delta = stack - player.stack;
  await applyLedgerEntry(runtime, {
    matchId,
    userId,
    stage,
    delta,
    reason,
    ts: Date.now(),
  });
};

const getBjPlayer = (runtime: MatchRuntime, userId: string): BjPlayerState | null => {
  const bj = runtime.blackjack;
  if (!bj?.roundState) return null;
  return bj.roundState.players[userId] ?? null;
};

const getBjRound = (runtime: MatchRuntime): BjRoundState | null => {
  return runtime.blackjack?.roundState ?? null;
};

const createBjState = (): BlackjackState => ({
  round: 0,
  roundsTotal: BJ_ROUNDS,
  status: "IN_PROGRESS",
  roundState: null,
});

const emitBjHandState = async (
  matchId: string,
  round: number,
  userId: string,
  hand: BjHand,
  roundStatus: BjRoundStatus,
  options?: { handIndex?: number }
) => {
  const isDealer = userId === "dealer";
  const hideHole = isDealer && roundStatus !== "DEALER_ACTION" && roundStatus !== "RESOLVED";
  const visibleCards = hideHole && hand.cards.length > 1 ? [hand.cards[0]] : hand.cards;
  const { total } = computeHandValue(visibleCards);
  const payload = {
    matchId,
    round,
    spot: hand.spot,
    userId,
    handIndex: options?.handIndex ?? 0,
    state: {
      cards: visibleCards.map((c) => ({ rank: c.rank, suit: c.suit })),
      total,
      status: hand.status,
      bet: hand.bet,
      result: hand.result,
      sideBet: hand.sideBet,
      sideResult: hand.sideResult,
      hidden: hideHole ? Math.max(hand.cards.length - 1, 0) : 0,
    },
  };
  await emitEvent(matchId, "BJ_HAND_STATE", payload);
};

const emitBjRoundStarted = async (matchId: string, round: number) => {
  await emitEvent(matchId, "BJ_ROUND_STARTED", { matchId, round, ts: Date.now() });
};

const emitBjRoundCompleted = async (matchId: string, round: number) => {
  await emitEvent(matchId, "BJ_ROUND_COMPLETED", { matchId, round, ts: Date.now() });
};

const startBlackjackRound = async (runtime: MatchRuntime, matchId: string) => {
  if (!runtime.blackjack) runtime.blackjack = createBjState();
  const bj = runtime.blackjack;
  if (bj.status !== "IN_PROGRESS") return;
  if (bj.round >= bj.roundsTotal) {
    bj.status = "DONE";
    return;
  }
  const ctx = runtime.orchestrator.getContext();
  const deck = buildDeck();
  shuffleDeck(deck);
  const players: Record<string, BjPlayerState> = {};
  for (const p of ctx.players) {
    players[p.userId] = {
      userId: p.userId,
      hands: [],
      placedBet: false,
      committed: 0,
    };
  }
  const roundState: BjRoundState = {
    round: bj.round + 1,
    status: "BETTING",
    deck,
    dealer: makeDealerHand(),
    players,
  };
  bj.round = roundState.round;
  bj.roundState = roundState;
  await emitBjRoundStarted(matchId, roundState.round);
  await emitBjHandState(matchId, roundState.round, "dealer", roundState.dealer, roundState.status);
};

const computeSideBetResult = (total: number, choice: BjSideBetChoice): "WIN" | "LOSE" | "PUSH" => {
  if (total === 13) return "PUSH";
  if (choice === "UNDER") return total < 13 ? "WIN" : "LOSE";
  return total > 13 ? "WIN" : "LOSE";
};

const dealInitialHands = async (runtime: MatchRuntime, matchId: string) => {
  const roundState = getBjRound(runtime);
  if (!roundState) return;
  roundState.status = "PLAYER_ACTION";
  const { dealer, deck } = roundState;

  for (const player of Object.values(roundState.players)) {
    for (const hand of player.hands) {
      hand.cards.push(drawCard(deck));
      hand.cards.push(drawCard(deck));
      const { total, blackjack } = computeHandValue(hand.cards);
      if (hand.sideBet) {
        hand.sideResult = computeSideBetResult(total, hand.sideBet);
      }
      if (blackjack) {
        hand.status = "BLACKJACK";
        hand.result = "BLACKJACK";
      } else {
        hand.status = "ACTIVE";
      }
    }
  }

  dealer.cards.push(drawCard(deck));
  dealer.cards.push(drawCard(deck));
  const dealerValue = computeHandValue(dealer.cards);
  const dealerBlackjack = dealerValue.blackjack;

  for (const player of Object.values(roundState.players)) {
    player.hands.forEach((hand, index) => {
      void emitBjHandState(matchId, roundState.round, player.userId, hand, roundState.status, { handIndex: index });
    });
  }
  await emitBjHandState(matchId, roundState.round, "dealer", dealer, roundState.status);

  const anyActive = Object.values(roundState.players).some((p) => p.hands.some((h) => h.status === "ACTIVE"));
  if (!anyActive || dealerBlackjack) {
    await resolveBjRound(runtime, matchId);
  }
};

const resolveBjHand = (hand: BjHand, dealerCards: BjCard[]): BjHandResult => {
  const handValue = computeHandValue(hand.cards);
  const dealerValue = computeHandValue(dealerCards);
  if (handValue.total > 21) return "LOSE";
  if (dealerValue.total > 21) return handValue.blackjack ? "BLACKJACK" : "WIN";
  if (handValue.blackjack && !dealerValue.blackjack) return "BLACKJACK";
  if (dealerValue.blackjack && !handValue.blackjack) return "LOSE";
  if (handValue.total > dealerValue.total) return "WIN";
  if (handValue.total < dealerValue.total) return "LOSE";
  if (handValue.total === 20) return "PUSH";
  if (handValue.total >= 17 && handValue.total <= 19) return "LOSE";
  if (handValue.total === 21) return handValue.blackjack ? "BLACKJACK" : "PUSH";
  return "PUSH";
};

const resolveBjRound = async (runtime: MatchRuntime, matchId: string) => {
  const roundState = getBjRound(runtime);
  if (!roundState) return;
  roundState.status = "DEALER_ACTION";
  const dealer = roundState.dealer;
  while (shouldDealerHit(dealer.cards)) {
    dealer.cards.push(drawCard(roundState.deck));
  }
  roundState.status = "RESOLVED";
  await emitBjHandState(matchId, roundState.round, "dealer", dealer, roundState.status);

  for (const player of Object.values(roundState.players)) {
    let deltaTotal = 0;
    for (const [index, hand] of player.hands.entries()) {
      const result = resolveBjHand(hand, dealer.cards);
      hand.result = result;
      if (hand.status === "ACTIVE") hand.status = "DONE";
      let delta = 0;
      if (result === "BLACKJACK") delta += Math.round(hand.bet * BJ_BLACKJACK_PAYOUT);
      if (result === "WIN") delta += hand.bet;
      if (result === "LOSE") delta -= hand.bet;
      if (hand.sideBet && hand.sideResult) {
        if (hand.sideResult === "WIN") delta += Math.round(hand.bet * BJ_SIDE_BET_PAYOUT);
        if (hand.sideResult === "LOSE") delta -= hand.bet;
      }
      deltaTotal += delta;
      await emitBjHandState(matchId, roundState.round, player.userId, hand, roundState.status, { handIndex: index });
    }
    if (deltaTotal !== 0) {
      await applyLedgerEntry(runtime, {
        matchId,
        userId: player.userId,
        stage: "BLACKJACK",
        delta: deltaTotal,
        reason: `blackjack_round_${roundState.round}`,
        ts: Date.now(),
      });
    }
  }

  await emitBjRoundCompleted(matchId, roundState.round);
  if (runtime.blackjack && runtime.blackjack.round < runtime.blackjack.roundsTotal) {
    await startBlackjackRound(runtime, matchId);
  } else if (runtime.blackjack) {
    runtime.blackjack.status = "DONE";
  }
};

const tryAdvanceBjRound = async (runtime: MatchRuntime, matchId: string) => {
  const roundState = getBjRound(runtime);
  if (!roundState) return;
  if (roundState.status !== "PLAYER_ACTION") return;
  const anyActive = Object.values(roundState.players).some((p) => p.hands.some((h) => h.status === "ACTIVE"));
  if (!anyActive) {
    await resolveBjRound(runtime, matchId);
  }
};

const seatOrder = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;

const getSeatMapByJoinOrder = (runtime: MatchRuntime) => {
  const ctx = runtime.orchestrator.getContext();
  const m = new Map<string, string>();
  ctx.players.forEach((p, i) => {
    const seat = seatOrder[i];
    if (seat) m.set(seat, p.userId);
  });
  return m;
};

const importYatzyScores = async (runtime: MatchRuntime, matchId: string, yatzyMatchId: string) => {
  const apiUrl = (process.env.YATZY_API_URL || "").trim();
  if (!apiUrl) {
    throw new Error("YATZY_API_URL missing");
  }

  const token = await getYatzyToken(runtime, apiUrl);

  const res = await fetch(`${apiUrl}/matches/${yatzyMatchId}/state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Yatzy API error ${res.status}`);
  }
  const data = await res.json();
  const scores = Array.isArray(data?.scores) ? data.scores : [];
  const totals = new Map<string, number>();
  for (const s of scores) {
    const seat = String(s.seat || "").toUpperCase();
    const score = Number(s.score || 0);
    totals.set(seat, (totals.get(seat) || 0) + (Number.isFinite(score) ? score : 0));
  }

  const seatMap = getSeatMapByJoinOrder(runtime);
  for (const [seat, userId] of seatMap.entries()) {
    const total = totals.get(seat) || 0;
    await applyAbsoluteStack(runtime, matchId, userId, total * 10, "YATZY", `yatzy_import:${yatzyMatchId}`);
  }
};

const createYatzyMatch = async (runtime: MatchRuntime, playerCount: number) => {
  const apiUrl = (process.env.YATZY_API_URL || "").trim();
  if (!apiUrl) {
    throw new Error("YATZY_API_URL missing");
  }

  const count = Math.max(2, Math.min(6, Math.trunc(playerCount || 0)));
  const token = await getYatzyToken(runtime, apiUrl);

  const res = await fetch(`${apiUrl}/matches/quickstart`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ playerCount: count, actionId: randomUUID() }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Yatzy quickstart error ${res.status}: ${body}`);
  }
  const data = await res.json();
  if (!data?.matchId) {
    throw new Error("Yatzy quickstart missing matchId");
  }
  return data.matchId as string;
};

const getAuthentikHeaders = (headers: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {};
  const keys = [
    "x-authentik-uid",
    "x-authentik-name",
    "x-authentik-email",
    "x-authentik-username",
    "x-authentik-jwt",
    "x-ytzy-player-code",
  ];
  for (const k of keys) {
    const v = headers[k] ?? headers[k.toLowerCase()];
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
};

const silentDisco = createSilentDiscoManager({
  parseJsonBody,
  getAuthentikHeaders,
});

const getYatzyToken = async (runtime: MatchRuntime, apiUrl: string): Promise<string> => {
  if (runtime.yatzyAuthToken) return runtime.yatzyAuthToken;
  if (!runtime.hostAuthHeaders || !runtime.hostAuthHeaders["x-authentik-uid"]) {
    throw new Error("Missing authentik identity for host");
  }
  const res = await fetch(`${apiUrl}/auth/claim`, {
    method: "POST",
    headers: {
      ...runtime.hostAuthHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ seat: "P1" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Yatzy auth/claim error ${res.status}: ${body}`);
  }
  const data = await res.json();
  if (!data?.token) {
    throw new Error("Yatzy auth/claim missing token");
  }
  runtime.yatzyAuthToken = data.token;
  return data.token as string;
};

io.on("connection", (socket) => {
  const userId = socket.id;
  // eslint-disable-next-line no-console
  console.log("socket connected", socket.id, socket.handshake.address, socket.handshake.headers.origin);
  const authHeaders = getAuthentikHeaders(socket.handshake.headers as Record<string, unknown>);
  silentDisco.bindSocketConnection(io, socket, authHeaders);
  socket.emit("event", {
    type: "AUTH_DEBUG",
    payload: {
      hasAuthentik: !!authHeaders["x-authentik-uid"],
      headers: Object.keys(authHeaders),
    },
  });

  socket.on("event", async (rawPayload) => {
    // eslint-disable-next-line no-console
    console.log("incoming event", rawPayload);
    const parsed = ClientEventSchema.safeParse(rawPayload);
    if (!parsed.success) {
      socket.emit("error", { error: "invalid_payload", details: parsed.error.flatten() });
      return;
    }

    const event = parsed.data as ClientEvent;

    if (event.type === "MATCH_CREATE") {
      const { match, runtime } = createMatch(event.mode, userId);
      await safeDb(() => upsertMatchRow(match));
      await saveSnapshotNow(runtime);
      await persistClientEvent(runtime, event, userId);
      socket.join(match.id);
      await emitEvent(match.id, "MATCH_CREATED", { match });
      await emitEvent(match.id, "MATCH_JOINED", { matchId: match.id, userId });
      runtime.hostAuthHeaders = getAuthentikHeaders(socket.handshake.headers as Record<string, unknown>);
      await emitMatchState(match.id, runtime);
      return;
    }

    if ("matchId" in event) {
      let runtime = getMatchRuntime(event.matchId);
      if (!runtime) {
        runtime = await recoverMatch(event.matchId);
      }
      if (!runtime) {
        socket.emit("error", { error: "match_not_found" });
        return;
      }

      await persistClientEvent(runtime, event, userId);

      if (event.type === "MATCH_JOIN") {
        joinMatch(runtime, event.matchId, userId);
        socket.join(event.matchId);
        await emitEvent(event.matchId, "MATCH_JOINED", { matchId: event.matchId, userId });
        await emitMatchState(event.matchId, runtime);
        return;
      }

      if (event.type === "MATCH_LEAVE") {
        socket.leave(event.matchId);
        await emitEvent(event.matchId, "MATCH_LEFT", { matchId: event.matchId, userId });
        await emitMatchState(event.matchId, runtime);
        return;
      }

      if (event.type === "READY_CHECK_CONFIRM") {
        runtime.ready.add(userId);
        const ctx = runtime.orchestrator.getContext();
        await emitMatchState(event.matchId, runtime);
        if (runtime.ready.size >= ctx.players.length) {
          await emitEvent(event.matchId, "READY_CHECK_PASSED", { matchId: event.matchId });
          setMatchStatus(runtime, "RUNNING");
          const nextStage = ctx.match.mode === "BLACKJACK_ONLY" ? "BLACKJACK" : "YATZY";
          const started = runtime.orchestrator.startStage(nextStage);
          if (started.ok) {
            for (const ev of started.events) {
              await emitEvent(event.matchId, ev.type, ev.payload);
            }
          }
          if (nextStage === "BLACKJACK") {
            await startBlackjackRound(runtime, event.matchId);
          }
          await safeDb(() => upsertMatchRow(runtime.orchestrator.getContext().match));
        }
        return;
      }

      if (event.type === "YATZY_SUBMIT") {
        runtime.yatzySubmissions.set(userId, event.score);
        const ctx = runtime.orchestrator.getContext();
        if (runtime.yatzySubmissions.size >= ctx.players.length) {
          for (const p of ctx.players) {
            const score = runtime.yatzySubmissions.get(p.userId) || 0;
            await applyAbsoluteStack(runtime, event.matchId, p.userId, score * 10, "YATZY", "yatzy_submit");
          }
          await emitEvent(event.matchId, "STAGE_COMPLETED", { matchId: event.matchId, stage: "YATZY", ts: Date.now() });
          const started = runtime.orchestrator.startStage("BLACKJACK");
          if (started.ok) {
            for (const ev of started.events) await emitEvent(event.matchId, ev.type, ev.payload);
          }
          await startBlackjackRound(runtime, event.matchId);
        }
        return;
      }

      if (event.type === "YATZY_IMPORT") {
        try {
          await importYatzyScores(runtime, event.matchId, event.yatzyMatchId);
          await emitEvent(event.matchId, "YATZY_IMPORTED", { matchId: event.matchId, yatzyMatchId: event.yatzyMatchId });
          await emitEvent(event.matchId, "STAGE_COMPLETED", { matchId: event.matchId, stage: "YATZY", ts: Date.now() });
          const started = runtime.orchestrator.startStage("BLACKJACK");
          if (started.ok) {
            for (const ev of started.events) await emitEvent(event.matchId, ev.type, ev.payload);
          }
          await startBlackjackRound(runtime, event.matchId);
        } catch (e) {
          socket.emit("error", { error: "yatzy_import_failed", details: String(e) });
        }
        return;
      }

      if (event.type === "YATZY_MATCH_SET") {
        if (userId !== runtime.hostUserId) {
          socket.emit("error", { error: "only_host_can_set_yatzy_match" });
          return;
        }
        runtime.yatzyMatchId = event.yatzyMatchId;
        await emitEvent(event.matchId, "YATZY_MATCH_SET", {
          matchId: event.matchId,
          yatzyMatchId: event.yatzyMatchId,
        });
        await emitMatchState(event.matchId, runtime);
        return;
      }

      if (event.type === "YATZY_CREATE") {
        if (userId !== runtime.hostUserId) {
          socket.emit("error", { error: "only_host_can_set_yatzy_match" });
          return;
        }
        try {
          const ctx = runtime.orchestrator.getContext();
          const yatzyMatchId = await createYatzyMatch(runtime, ctx.players.length);
          runtime.yatzyMatchId = yatzyMatchId;
          await emitEvent(event.matchId, "YATZY_MATCH_CREATED", {
            matchId: event.matchId,
            yatzyMatchId,
          });
          await emitMatchState(event.matchId, runtime);
        } catch (e) {
          socket.emit("error", { error: "yatzy_create_failed", details: String(e) });
        }
        return;
      }

      if (event.type === "BJ_BET_PLACED") {
        const roundState = getBjRound(runtime);
        if (!roundState || roundState.round !== event.round) {
          socket.emit("error", { error: "bj_round_mismatch" });
          return;
        }
        if (roundState.status !== "BETTING") {
          socket.emit("error", { error: "bj_not_accepting_bets" });
          return;
        }
        const player = getBjPlayer(runtime, userId);
        if (!player) {
          socket.emit("error", { error: "bj_player_missing" });
          return;
        }
        if (player.placedBet) {
          socket.emit("error", { error: "bj_already_bet" });
          return;
        }
        const spots = Array.from(new Set(event.spots)).slice(0, BJ_MAX_SPOTS);
        const bet = Math.trunc(event.bet);
        if (!Number.isFinite(bet) || bet < BJ_MIN_BET || bet > BJ_MAX_BET) {
          socket.emit("error", { error: "bj_invalid_bet" });
          return;
        }
        const sideBets = new Map<number, BjSideBetChoice>();
        if (Array.isArray((event as any).sideBets)) {
          for (const sb of (event as any).sideBets) {
            const spot = Number(sb?.spot);
            const choice = sb?.choice as BjSideBetChoice;
            if (Number.isFinite(spot) && (choice === "UNDER" || choice === "OVER")) {
              sideBets.set(spot, choice);
            }
          }
        }
        const ctx = runtime.orchestrator.getContext();
        const stack = ctx.players.find((p) => p.userId === userId)?.stack ?? 0;
        const totalBet = spots.length * bet;
        if (totalBet + player.committed > stack) {
          socket.emit("error", { error: "bj_insufficient_stack" });
          return;
        }
        player.hands = spots.map((spot) => ({
          spot,
          cards: [],
          bet,
          status: "ACTIVE",
          isSplit: false,
          fromSplitAces: false,
          sideBet: sideBets.get(spot) ?? null,
        }));
        player.placedBet = true;
        player.committed += totalBet;

        if (Object.values(roundState.players).every((p) => p.placedBet)) {
          await dealInitialHands(runtime, event.matchId);
        }
        return;
      }

      if (event.type === "BJ_HAND_ACTION") {
        const roundState = getBjRound(runtime);
        if (!roundState || roundState.round !== event.round) {
          socket.emit("error", { error: "bj_round_mismatch" });
          return;
        }
        if (roundState.status !== "PLAYER_ACTION") {
          socket.emit("error", { error: "bj_not_accepting_actions" });
          return;
        }
        const player = getBjPlayer(runtime, userId);
        if (!player) {
          socket.emit("error", { error: "bj_player_missing" });
          return;
        }
        const handIndex =
          typeof (event as any).handIndex === "number"
            ? Math.max(0, Math.trunc((event as any).handIndex))
            : -1;
        const hand =
          handIndex >= 0
            ? player.hands[handIndex]
            : player.hands.find((h) => h.spot === event.spot && h.status === "ACTIVE");
        if (!hand || hand.status !== "ACTIVE") {
          socket.emit("error", { error: "bj_hand_not_active" });
          return;
        }
        const deck = roundState.deck;
        const ctx = runtime.orchestrator.getContext();
        const stack = ctx.players.find((p) => p.userId === userId)?.stack ?? 0;

        if (event.action === "HIT") {
          hand.cards.push(drawCard(deck));
          const value = computeHandValue(hand.cards);
          if (value.total > 21) {
            hand.status = "BUST";
          } else if (value.total === 21) {
            hand.status = "DONE";
          }
        }

        if (event.action === "STAND") {
          hand.status = "DONE";
        }

        if (event.action === "DOUBLE") {
          if (hand.cards.length !== 2 || hand.fromSplitAces) {
            socket.emit("error", { error: "bj_cannot_double" });
            return;
          }
          if (player.committed + hand.bet > stack) {
            socket.emit("error", { error: "bj_insufficient_stack" });
            return;
          }
          player.committed += hand.bet;
          hand.bet += hand.bet;
          hand.cards.push(drawCard(deck));
          const value = computeHandValue(hand.cards);
          hand.status = value.total > 21 ? "BUST" : "DONE";
        }

        if (event.action === "SPLIT") {
          if (hand.cards.length !== 2) {
            socket.emit("error", { error: "bj_cannot_split" });
            return;
          }
          if (hand.cards[0].rank !== hand.cards[1].rank) {
            socket.emit("error", { error: "bj_cannot_split" });
            return;
          }
          if (player.committed + hand.bet > stack) {
            socket.emit("error", { error: "bj_insufficient_stack" });
            return;
          }
          player.committed += hand.bet;
          const [first, second] = hand.cards;
          hand.cards = [first];
          const splitAces = first.rank === "A";
          hand.isSplit = true;
          hand.fromSplitAces = splitAces;
          const newHand: BjHand = {
            spot: hand.spot,
            cards: [second],
            bet: hand.bet,
            status: "ACTIVE",
            isSplit: true,
            fromSplitAces: splitAces,
            sideBet: null,
          };
          const insertIndex = handIndex >= 0 ? handIndex + 1 : player.hands.length;
          player.hands.splice(insertIndex, 0, newHand);
          hand.cards.push(drawCard(deck));
          newHand.cards.push(drawCard(deck));
          if (splitAces) {
            hand.status = "DONE";
            newHand.status = "DONE";
          }
        }

        player.hands.forEach((h, index) => {
          void emitBjHandState(event.matchId, roundState.round, player.userId, h, roundState.status, { handIndex: index });
        });

        await tryAdvanceBjRound(runtime, event.matchId);
        return;
      }

      const res = runtime.orchestrator.handleClientEvent(event, userId);
      if (!res.ok) {
        socket.emit("error", { error: res.error });
        return;
      }

      for (const ev of res.events) {
        await emitEvent(event.matchId, ev.type, ev.payload);
      }
    }
  });

  socket.on("disconnect", () => {
    // eslint-disable-next-line no-console
    console.log("socket disconnected", socket.id);
    for (const [matchId, runtime] of matches.entries()) {
      const ctx = runtime.orchestrator.getContext();
      const player = ctx.players.find((p) => p.userId === userId);
      if (player) {
        player.isConnected = false;
        emitEvent(matchId, "MATCH_LEFT", { matchId, userId });
      }
    }
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`chkn api listening on :${PORT}`);
});
