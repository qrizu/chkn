import { z } from "zod";

export const StageSchema = z.enum([
  "LOBBY",
  "YATZY",
  "BLACKJACK",
  "ROULETTE",
  "TRIVIA",
  "DICE",
  "MUSIC",
  "HOLDEM",
  "RESULTS",
]);

export const MatchModeSchema = z.enum(["CHICKEN_RUN", "FIVE_KAMP"]);
export const MatchStatusSchema = z.enum(["CREATED", "RUNNING", "COMPLETED", "CANCELLED"]);

export const MatchSchema = z.object({
  id: z.string(),
  mode: MatchModeSchema,
  status: MatchStatusSchema,
  createdAt: z.number(),
});

export const MatchPlayerSchema = z.object({
  matchId: z.string(),
  userId: z.string(),
  seat: z.number().int(),
  stack: z.number().int(),
  isConnected: z.boolean(),
  isBot: z.boolean(),
});

export const StageStateSchema = z.object({
  matchId: z.string(),
  stage: StageSchema,
  stateJson: z.unknown(),
  startedAt: z.number(),
});

export const LedgerEntrySchema = z.object({
  matchId: z.string(),
  userId: z.string(),
  stage: StageSchema,
  delta: z.number().int(),
  reason: z.string(),
  ts: z.number(),
});

export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MATCH_CREATED"), match: MatchSchema }),
  z.object({ type: z.literal("MATCH_JOINED"), matchId: z.string(), userId: z.string() }),
  z.object({ type: z.literal("MATCH_LEFT"), matchId: z.string(), userId: z.string() }),
  z.object({ type: z.literal("READY_CHECK_STARTED"), matchId: z.string() }),
  z.object({ type: z.literal("READY_CHECK_PASSED"), matchId: z.string() }),
  z.object({ type: z.literal("YATZY_IMPORTED"), matchId: z.string(), yatzyMatchId: z.string() }),
  z.object({ type: z.literal("YATZY_MATCH_SET"), matchId: z.string(), yatzyMatchId: z.string() }),
  z.object({ type: z.literal("YATZY_MATCH_CREATED"), matchId: z.string(), yatzyMatchId: z.string() }),
  z.object({ type: z.literal("STAGE_STARTED"), matchId: z.string(), stage: StageSchema, ts: z.number() }),
  z.object({ type: z.literal("STAGE_COMPLETED"), matchId: z.string(), stage: StageSchema, ts: z.number() }),
  z.object({ type: z.literal("LEDGER_ENTRY_APPLIED"), entry: LedgerEntrySchema }),
  z.object({ type: z.literal("STACK_UPDATED"), matchId: z.string(), userId: z.string(), stack: z.number().int() }),
  z.object({ type: z.literal("MATCH_COMPLETED"), matchId: z.string() }),
]);

export const ClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MATCH_CREATE"), mode: MatchModeSchema }),
  z.object({ type: z.literal("MATCH_JOIN"), matchId: z.string() }),
  z.object({ type: z.literal("MATCH_LEAVE"), matchId: z.string() }),
  z.object({ type: z.literal("READY_CHECK_CONFIRM"), matchId: z.string() }),
  z.object({ type: z.literal("YATZY_SUBMIT"), matchId: z.string(), score: z.number().int().min(0) }),
  z.object({ type: z.literal("YATZY_IMPORT"), matchId: z.string(), yatzyMatchId: z.string() }),
  z.object({ type: z.literal("YATZY_MATCH_SET"), matchId: z.string(), yatzyMatchId: z.string() }),
  z.object({ type: z.literal("YATZY_CREATE"), matchId: z.string() }),
  z.object({
    type: z.literal("BJ_BET_PLACED"),
    matchId: z.string(),
    round: z.number().int().min(1).max(5),
    spots: z.array(z.number().int().min(1).max(7)).max(7),
    bet: z.number().int().min(10).max(100),
  }),
  z.object({
    type: z.literal("BJ_HAND_ACTION"),
    matchId: z.string(),
    round: z.number().int().min(1).max(5),
    spot: z.number().int().min(1).max(7),
    action: z.enum(["HIT", "STAND", "DOUBLE", "SPLIT"]),
  }),
  z.object({
    type: z.literal("ROULETTE_BET_PLACED"),
    matchId: z.string(),
    color: z.enum(["RED", "BLACK"]),
    bet: z.number().int().min(1),
  }),
  z.object({
    type: z.literal("TRIVIA_CATEGORY_PICKED"),
    matchId: z.string(),
    categoryId: z.string(),
  }),
  z.object({
    type: z.literal("TRIVIA_ANSWER_SUBMITTED"),
    matchId: z.string(),
    questionId: z.string(),
    answerId: z.string(),
  }),
  z.object({
    type: z.literal("DICE_BET_PLACED"),
    matchId: z.string(),
    choice: z.enum(["HIGHER", "LOWER"]),
    bet: z.number().int().min(1),
  }),
  z.object({
    type: z.literal("MUSIC_GUESS_SUBMITTED"),
    matchId: z.string(),
    round: z.number().int().min(1).max(5),
    guess: z.string().min(1),
  }),
  z.object({
    type: z.literal("HOLDEM_ACTION_SUBMITTED"),
    matchId: z.string(),
    action: z.enum(["FOLD", "CHECK", "CALL", "BET", "RAISE"]),
    amount: z.number().int().min(1).optional(),
  }),
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ClientEvent = z.infer<typeof ClientEventSchema>;
