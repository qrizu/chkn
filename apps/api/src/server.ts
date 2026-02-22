import "dotenv/config";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import sharp from "sharp";
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
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxBytes) {
        reject(new Error("payload_too_large"));
      }
    });
    req.on("end", () => {
      if (!data.trim()) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
};

const AVATAR_UPLOAD_MAX_BYTES = 8_000_000;
const AVATAR_UPLOAD_PAYLOAD_MAX_BYTES = 12_000_000;
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
    ensureUserAvatarsTablePromise = pool
      .query(
        `CREATE TABLE IF NOT EXISTS user_avatars (
           user_id TEXT PRIMARY KEY,
           avatar_mime_type TEXT NOT NULL,
           avatar_data BYTEA NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`
      )
      .then(() => undefined)
      .catch(async (err) => {
        const msg = String((err as Error)?.message || err).toLowerCase();
        if (msg.includes("permission denied")) {
          try {
            const exists = await pool.query(`SELECT to_regclass('chkn.user_avatars') AS t`);
            if (exists.rows[0]?.t) return;
          } catch {
            // fall through to throw original error
          }
        }
        ensureUserAvatarsTablePromise = null;
        throw err;
      });
  }
  return ensureUserAvatarsTablePromise;
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

const avatarLookupCandidates = (userId: string | null, username: string | null): string[] => {
  const out: string[] = [];
  const uid = String(userId || "").trim();
  if (uid) out.push(uid);
  if (username) out.push(...avatarStemCandidates(username));
  return Array.from(new Set(out));
};

const loadAvatarFromDbCandidates = async (
  candidates: string[]
): Promise<{ mimeType: string; buffer: Buffer } | null> => {
  if (!candidates.length) return null;
  await ensureUserAvatarsTable();
  const avatarResult = await pool.query(
    `SELECT user_id, avatar_mime_type, avatar_data
     FROM user_avatars
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
    return String(requestUrl.searchParams.get("lang") || "").trim() || "en-US";
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
      .then(([result, userInfo]) => {
        const row = result.rowCount ? result.rows[0] : null;
        if (row?.birth_date) {
          row.birth_date = toDateStringWithTz(row.birth_date, row.tz_name ?? null);
        }
        const fallbackUser = {
          username: authHeaders["x-authentik-username"] ?? null,
          email: authHeaders["x-authentik-email"] ?? null,
          name: authHeaders["x-authentik-name"] ?? null,
        };
        const user = { ...(fallbackUser || {}), ...(userInfo || {}) };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, profile: row, user, missing: !row }));
      })
      .catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "db_error", details: String(err) }));
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
        const dbAvatar = await loadAvatarFromDbCandidates(avatarLookupCandidates(userId, username));
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
          `INSERT INTO user_avatars (user_id, avatar_mime_type, avatar_data)
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
    const ua = (process.env.PLACES_USER_AGENT || "chkn-dev/1.0").trim();
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
    parseJsonBody(req)
      .then(async (body) => {
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
      })
      .catch((err) => {
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
    pool
      .query(
        `SELECT insight_id, summary_json, astrology_json, human_design_json, created_at
         FROM profile_insights
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [requestedId]
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
  if (req.url?.startsWith("/api/profile/") && req.method === "GET") {
    const authUserId = getUserIdFromReq(req);
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
    pool
      .query(
        `SELECT user_id, birth_date::text as birth_date, birth_time::text as birth_time, unknown_time, birth_place, birth_lat, birth_lng, tz_name, tz_offset_minutes
         FROM user_profiles
         WHERE user_id = $1`,
        [requestedId]
      )
      .then((result) => {
        const row = result.rowCount ? result.rows[0] : null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, profile: row }));
      })
      .catch((err) => {
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
