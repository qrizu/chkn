export type Stage =
  | "LOBBY"
  | "YATZY"
  | "BLACKJACK"
  | "ROULETTE"
  | "TRIVIA"
  | "DICE"
  | "MUSIC"
  | "HOLDEM"
  | "RESULTS";

export type MatchMode = "CHICKEN_RUN" | "FIVE_KAMP" | "BLACKJACK_ONLY";

export type MatchStatus = "CREATED" | "RUNNING" | "COMPLETED" | "CANCELLED";

export type Match = {
  id: string;
  mode: MatchMode;
  status: MatchStatus;
  createdAt: number;
};

export type MatchPlayer = {
  matchId: string;
  userId: string;
  seat: number;
  stack: number;
  isConnected: boolean;
  isBot: boolean;
};

export type StageState = {
  matchId: string;
  stage: Stage;
  stateJson: unknown;
  startedAt: number;
};

export type LedgerEntry = {
  matchId: string;
  userId: string;
  stage: Stage;
  delta: number;
  reason: string;
  ts: number;
};

export type ServerEvent =
  | { type: "MATCH_CREATED"; match: Match }
  | { type: "MATCH_JOINED"; matchId: string; userId: string }
  | { type: "MATCH_LEFT"; matchId: string; userId: string }
  | { type: "READY_CHECK_STARTED"; matchId: string }
  | { type: "READY_CHECK_PASSED"; matchId: string }
  | { type: "YATZY_IMPORTED"; matchId: string; yatzyMatchId: string }
  | { type: "YATZY_MATCH_SET"; matchId: string; yatzyMatchId: string }
  | { type: "YATZY_MATCH_CREATED"; matchId: string; yatzyMatchId: string }
  | { type: "STAGE_STARTED"; matchId: string; stage: Stage; ts: number }
  | { type: "STAGE_COMPLETED"; matchId: string; stage: Stage; ts: number }
  | { type: "BJ_ROUND_STARTED"; matchId: string; round: number; ts: number }
  | { type: "BJ_HAND_STATE"; matchId: string; round: number; spot: number; userId: string; state: any }
  | { type: "BJ_ROUND_COMPLETED"; matchId: string; round: number; ts: number }
  | { type: "LEDGER_ENTRY_APPLIED"; entry: LedgerEntry }
  | { type: "STACK_UPDATED"; matchId: string; userId: string; stack: number }
  | { type: "MATCH_COMPLETED"; matchId: string };

export type ClientEvent =
  | { type: "MATCH_CREATE"; mode: MatchMode }
  | { type: "MATCH_JOIN"; matchId: string }
  | { type: "MATCH_LEAVE"; matchId: string }
  | { type: "READY_CHECK_CONFIRM"; matchId: string }
  | { type: "YATZY_SUBMIT"; matchId: string; score: number }
  | { type: "YATZY_IMPORT"; matchId: string; yatzyMatchId: string }
  | { type: "YATZY_MATCH_SET"; matchId: string; yatzyMatchId: string }
  | { type: "YATZY_CREATE"; matchId: string }
  | { type: "BJ_BET_PLACED"; matchId: string; round: number; spots: number[]; bet: number; sideBets?: Array<{ spot: number; choice: "UNDER" | "OVER" }> }
  | { type: "BJ_HAND_ACTION"; matchId: string; round: number; spot: number; action: "HIT" | "STAND" | "DOUBLE" | "SPLIT"; handIndex?: number }
  | { type: "ROULETTE_BET_PLACED"; matchId: string; color: "RED" | "BLACK"; bet: number }
  | { type: "TRIVIA_CATEGORY_PICKED"; matchId: string; categoryId: string }
  | { type: "TRIVIA_ANSWER_SUBMITTED"; matchId: string; questionId: string; answerId: string }
  | { type: "DICE_BET_PLACED"; matchId: string; choice: "HIGHER" | "LOWER"; bet: number }
  | { type: "MUSIC_GUESS_SUBMITTED"; matchId: string; round: number; guess: string }
  | { type: "HOLDEM_ACTION_SUBMITTED"; matchId: string; action: "FOLD" | "CHECK" | "CALL" | "BET" | "RAISE"; amount?: number };
