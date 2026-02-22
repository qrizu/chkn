import type { ClientEvent, LedgerEntry, Match, MatchPlayer, MatchStatus, Stage } from "../../packages/shared/events";
import {
  appendEvent,
  saveRedisState,
  saveSnapshot,
  safeDb,
  safeRedis,
  type PersistedMatchState,
} from "./persistence";

export type RuntimeLike = {
  orchestrator: { getContext(): { match: Match; players: MatchPlayer[]; stage: Stage; status: MatchStatus } };
  ready: Set<string>;
  ledger: LedgerEntry[];
  yatzySubmissions: Map<string, number>;
  yatzyMatchId: string | null;
  hostUserId: string;
  blackjack: any;
  seq: number;
};

export const snapshotOnTypes = new Set([
  "MATCH_CREATED",
  "MATCH_JOINED",
  "MATCH_LEFT",
  "READY_CHECK_PASSED",
  "STAGE_STARTED",
  "STAGE_COMPLETED",
  "LEDGER_ENTRY_APPLIED",
  "YATZY_IMPORTED",
  "YATZY_MATCH_SET",
  "YATZY_MATCH_CREATED",
  "BJ_ROUND_STARTED",
  "BJ_HAND_STATE",
  "BJ_ROUND_COMPLETED",
]);

export const buildPersistedState = (runtime: RuntimeLike): PersistedMatchState => {
  const ctx = runtime.orchestrator.getContext();
  return {
    match: ctx.match,
    players: ctx.players,
    stage: ctx.stage,
    status: ctx.status,
    readyUserIds: Array.from(runtime.ready),
    ledger: runtime.ledger,
    yatzySubmissions: Array.from(runtime.yatzySubmissions.entries()),
    yatzyMatchId: runtime.yatzyMatchId,
    hostUserId: runtime.hostUserId,
    blackjack: runtime.blackjack ?? null,
    seq: runtime.seq,
  };
};

export const persistClientEvent = async (runtime: RuntimeLike, event: ClientEvent, userId: string) => {
  const seq = runtime.seq + 1;
  runtime.seq = seq;
  await safeDb(() =>
    appendEvent({
      matchId: runtime.orchestrator.getContext().match.id,
      seq,
      type: event.type,
      payload: { source: "client", userId, ...event },
    })
  );
  await safeRedis(() => saveRedisState(buildPersistedState(runtime)));
};

export const persistServerEvent = async (
  runtime: RuntimeLike,
  matchId: string,
  type: string,
  payload: unknown
) => {
  const seq = runtime.seq + 1;
  runtime.seq = seq;
  const serverPayload =
    payload && typeof payload === "object"
      ? { source: "server", ...(payload as object) }
      : { source: "server", value: payload };

  await safeDb(() =>
    appendEvent({
      matchId,
      seq,
      type,
      payload: serverPayload,
    })
  );

  if (snapshotOnTypes.has(type)) {
    await safeDb(() => saveSnapshot(buildPersistedState(runtime)));
  }

  await safeRedis(() => saveRedisState(buildPersistedState(runtime)));
};

export const saveSnapshotNow = async (runtime: RuntimeLike) => {
  await safeDb(() => saveSnapshot(buildPersistedState(runtime)));
  await safeRedis(() => saveRedisState(buildPersistedState(runtime)));
};

export const saveRedisOnly = async (runtime: RuntimeLike) => {
  await safeRedis(() => saveRedisState(buildPersistedState(runtime)));
};
