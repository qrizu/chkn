import type { LedgerEntry, Match, MatchPlayer, MatchStatus, Stage } from "../../packages/shared/events";
import pool from "./db/pool";
import { getRedis } from "./db/redis";

export type PersistedMatchState = {
  match: Match;
  players: MatchPlayer[];
  stage: Stage;
  status: MatchStatus;
  readyUserIds: string[];
  ledger: LedgerEntry[];
  yatzySubmissions: Array<[string, number]>;
  yatzyMatchId: string | null;
  hostUserId: string;
  blackjack?: unknown;
  seq: number;
};

const redisKey = (matchId: string) => `chkn:match:${matchId}`;
const redisTtlSec = Number(process.env.REDIS_MATCH_TTL_SEC || 21_600);

export const upsertMatchRow = async (match: Match): Promise<void> => {
  const sql = `
    INSERT INTO matches (match_id, mode, status, created_at, updated_at)
    VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), NOW())
    ON CONFLICT (match_id)
    DO UPDATE SET mode = EXCLUDED.mode, status = EXCLUDED.status, updated_at = NOW()`;
  await pool.query(sql, [match.id, match.mode, match.status, match.createdAt]);
};

export const updateMatchStatus = async (matchId: string, status: MatchStatus): Promise<void> => {
  const sql = `
    UPDATE matches
    SET status = $2
    WHERE match_id = $1`;
  await pool.query(sql, [matchId, status]);
};

export const appendEvent = async (params: {
  matchId: string;
  seq: number;
  type: string;
  payload: unknown;
}): Promise<void> => {
  const sql = `
    INSERT INTO match_events (match_id, seq, type, payload)
    VALUES ($1, $2, $3, $4)`;
  await pool.query(sql, [params.matchId, params.seq, params.type, params.payload ?? {}]);
};

export const saveSnapshot = async (state: PersistedMatchState): Promise<void> => {
  const sql = `
    INSERT INTO match_snapshots (match_id, seq, state_json)
    VALUES ($1, $2, $3)
    ON CONFLICT (match_id, seq) DO NOTHING`;
  await pool.query(sql, [state.match.id, state.seq, state]);
};

export const saveRedisState = async (state: PersistedMatchState): Promise<void> => {
  const client = await getRedis();
  const payload = JSON.stringify(state);
  if (Number.isFinite(redisTtlSec) && redisTtlSec > 0) {
    await client.set(redisKey(state.match.id), payload, { EX: redisTtlSec });
  } else {
    await client.set(redisKey(state.match.id), payload);
  }
};

export const loadRedisState = async (matchId: string): Promise<PersistedMatchState | null> => {
  const client = await getRedis();
  const raw = await client.get(redisKey(matchId));
  if (!raw) return null;
  return JSON.parse(raw) as PersistedMatchState;
};

export const loadSnapshotFromDb = async (matchId: string): Promise<PersistedMatchState | null> => {
  const sql = `
    SELECT state_json
    FROM match_snapshots
    WHERE match_id = $1
    ORDER BY seq DESC
    LIMIT 1`;
  const res = await pool.query(sql, [matchId]);
  if (!res.rowCount) return null;
  return res.rows[0].state_json as PersistedMatchState;
};

export const loadEventsAfterSeq = async (matchId: string, seq: number): Promise<Array<{ seq: number; type: string; payload: any }>> => {
  const sql = `
    SELECT seq, type, payload
    FROM match_events
    WHERE match_id = $1 AND seq > $2
    ORDER BY seq ASC`;
  const res = await pool.query(sql, [matchId, seq]);
  return res.rows as Array<{ seq: number; type: string; payload: any }>;
};

export const safeDb = async (fn: () => Promise<void>) => {
  try {
    await fn();
  } catch (err) {
    console.error("[db] persist error:", err?.message || err);
  }
};

export const safeRedis = async (fn: () => Promise<void>) => {
  try {
    await fn();
  } catch (err) {
    console.error("[redis] persist error:", err?.message || err);
  }
};

export const safeDbValue = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    console.error("[db] load error:", err?.message || err);
    return fallback;
  }
};

export const safeRedisValue = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    console.error("[redis] load error:", err?.message || err);
    return fallback;
  }
};
