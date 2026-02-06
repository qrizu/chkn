import "dotenv/config";
import http from "node:http";
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
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

type MatchRuntime = {
  orchestrator: MatchOrchestrator;
  ready: Set<string>;
  ledger: LedgerEntry[];
  yatzySubmissions: Map<string, number>;
  yatzyMatchId: string | null;
  hostUserId: string;
  hostAuthHeaders: Record<string, string>;
  yatzyAuthToken: string | null;
  seq: number;
};

const matches = new Map<string, MatchRuntime>();

const parseJsonBody = async (req: http.IncomingMessage): Promise<any> => {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
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
        `SELECT user_id, birth_date, birth_time, unknown_time, birth_place, birth_lat, birth_lng, tz_name, tz_offset_minutes
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
        `SELECT birth_date, birth_time, unknown_time, birth_place, birth_lat, birth_lng, tz_name, tz_offset_minutes
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
  if (req.url === "/api/profile/insights/calc" && req.method === "POST") {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    pool
      .query(
        `SELECT birth_date, birth_time, unknown_time, birth_place, birth_lat, birth_lng, tz_name, tz_offset_minutes
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
    players: ctx.players.map((p) => ({ userId: p.userId, stack: p.stack })),
    readyUserIds: Array.from(runtime.ready),
    stage: ctx.stage,
    status: ctx.status,
    hostUserId: runtime.hostUserId,
    yatzyMatchId: runtime.yatzyMatchId,
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
    seq: 0,
  };
  matches.set(matchId, runtime);
  return { match, runtime };
};

const joinMatch = (runtime: MatchRuntime, matchId: string, userId: string) => {
  const ctx = runtime.orchestrator.getContext();
  if (ctx.players.some((p) => p.userId === userId)) return;
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
          const started = runtime.orchestrator.startStage("YATZY");
          if (started.ok) {
            for (const ev of started.events) {
              await emitEvent(event.matchId, ev.type, ev.payload);
            }
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
