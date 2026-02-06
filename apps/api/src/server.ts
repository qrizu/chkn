import "dotenv/config";
import http from "node:http";
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";
import { ClientEventSchema } from "../../../packages/shared/schemas";
import { MatchOrchestrator } from "../../../packages/game-engine/orchestrator";
import type { ClientEvent, LedgerEntry, Match, MatchMode, MatchPlayer, MatchStatus, Stage } from "../../../packages/shared/events";

type MatchRuntime = {
  orchestrator: MatchOrchestrator;
  ready: Set<string>;
  ledger: LedgerEntry[];
  yatzySubmissions: Map<string, number>;
  yatzyMatchId: string | null;
  hostUserId: string;
  hostAuthHeaders: Record<string, string>;
  yatzyAuthToken: string | null;
};

const matches = new Map<string, MatchRuntime>();

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
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

const emitEvent = (matchId: string, type: string, payload: unknown) => {
  io.to(matchId).emit("event", { type, payload });
};

const emitMatchState = (matchId: string, runtime: MatchRuntime) => {
  const ctx = runtime.orchestrator.getContext();
  emitEvent(matchId, "MATCH_STATE", {
    matchId,
    players: ctx.players.map((p) => ({ userId: p.userId, stack: p.stack })),
    readyUserIds: Array.from(runtime.ready),
    stage: ctx.stage,
    status: ctx.status,
    hostUserId: runtime.hostUserId,
    yatzyMatchId: runtime.yatzyMatchId,
  });
};

const getMatchRuntime = (matchId: string): MatchRuntime | null => {
  return matches.get(matchId) ?? null;
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
  runtime.orchestrator.getContext().status = status;
};

const applyLedgerEntry = (runtime: MatchRuntime, entry: LedgerEntry) => {
  const ctx = runtime.orchestrator.getContext();
  const player = ctx.players.find((p) => p.userId === entry.userId);
  if (!player) return;
  player.stack += entry.delta;
  runtime.ledger.push(entry);
  emitEvent(entry.matchId, "LEDGER_ENTRY_APPLIED", { entry });
  emitEvent(entry.matchId, "STACK_UPDATED", { matchId: entry.matchId, userId: entry.userId, stack: player.stack });
};

const applyAbsoluteStack = (runtime: MatchRuntime, matchId: string, userId: string, stack: number, stage: Stage, reason: string) => {
  const ctx = runtime.orchestrator.getContext();
  const player = ctx.players.find((p) => p.userId === userId);
  if (!player) return;
  const delta = stack - player.stack;
  applyLedgerEntry(runtime, {
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
    applyAbsoluteStack(runtime, matchId, userId, total * 10, "YATZY", `yatzy_import:${yatzyMatchId}`);
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
      const { match } = createMatch(event.mode, userId);
      socket.join(match.id);
      emitEvent(match.id, "MATCH_CREATED", { match });
      emitEvent(match.id, "MATCH_JOINED", { matchId: match.id, userId });
      const runtime = getMatchRuntime(match.id);
      if (runtime) {
        runtime.hostAuthHeaders = getAuthentikHeaders(socket.handshake.headers as Record<string, unknown>);
        emitMatchState(match.id, runtime);
      }
      return;
    }

    if ("matchId" in event) {
      const runtime = getMatchRuntime(event.matchId);
      if (!runtime) {
        socket.emit("error", { error: "match_not_found" });
        return;
      }

      if (event.type === "MATCH_JOIN") {
        joinMatch(runtime, event.matchId, userId);
        socket.join(event.matchId);
        emitEvent(event.matchId, "MATCH_JOINED", { matchId: event.matchId, userId });
        emitMatchState(event.matchId, runtime);
        return;
      }

      if (event.type === "MATCH_LEAVE") {
        socket.leave(event.matchId);
        emitEvent(event.matchId, "MATCH_LEFT", { matchId: event.matchId, userId });
        emitMatchState(event.matchId, runtime);
        return;
      }

      if (event.type === "READY_CHECK_CONFIRM") {
        runtime.ready.add(userId);
        const ctx = runtime.orchestrator.getContext();
        emitMatchState(event.matchId, runtime);
        if (runtime.ready.size >= ctx.players.length) {
          emitEvent(event.matchId, "READY_CHECK_PASSED", { matchId: event.matchId });
          setMatchStatus(runtime, "RUNNING");
          const started = runtime.orchestrator.startStage("YATZY");
          if (started.ok) {
            for (const ev of started.events) {
              emitEvent(event.matchId, ev.type, ev.payload);
            }
          }
        }
        return;
      }

      if (event.type === "YATZY_SUBMIT") {
        runtime.yatzySubmissions.set(userId, event.score);
        const ctx = runtime.orchestrator.getContext();
        if (runtime.yatzySubmissions.size >= ctx.players.length) {
          for (const p of ctx.players) {
            const score = runtime.yatzySubmissions.get(p.userId) || 0;
            applyAbsoluteStack(runtime, event.matchId, p.userId, score * 10, "YATZY", "yatzy_submit");
          }
          emitEvent(event.matchId, "STAGE_COMPLETED", { matchId: event.matchId, stage: "YATZY", ts: Date.now() });
          const started = runtime.orchestrator.startStage("BLACKJACK");
          if (started.ok) {
            for (const ev of started.events) emitEvent(event.matchId, ev.type, ev.payload);
          }
        }
        return;
      }

      if (event.type === "YATZY_IMPORT") {
        try {
          await importYatzyScores(runtime, event.matchId, event.yatzyMatchId);
          emitEvent(event.matchId, "YATZY_IMPORTED", { matchId: event.matchId, yatzyMatchId: event.yatzyMatchId });
          emitEvent(event.matchId, "STAGE_COMPLETED", { matchId: event.matchId, stage: "YATZY", ts: Date.now() });
          const started = runtime.orchestrator.startStage("BLACKJACK");
          if (started.ok) {
            for (const ev of started.events) emitEvent(event.matchId, ev.type, ev.payload);
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
        emitEvent(event.matchId, "YATZY_MATCH_SET", {
          matchId: event.matchId,
          yatzyMatchId: event.yatzyMatchId,
        });
        emitMatchState(event.matchId, runtime);
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
          emitEvent(event.matchId, "YATZY_MATCH_CREATED", {
            matchId: event.matchId,
            yatzyMatchId,
          });
          emitMatchState(event.matchId, runtime);
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
        emitEvent(event.matchId, ev.type, ev.payload);
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
