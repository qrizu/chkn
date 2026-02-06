import type { ClientEvent, MatchStatus, Stage } from "./events";

export type ClientEventType = ClientEvent["type"];

export const allowedClientEventsByStage: Record<Stage, ClientEventType[]> = {
  LOBBY: ["MATCH_CREATE", "MATCH_JOIN", "MATCH_LEAVE", "READY_CHECK_CONFIRM"],
  YATZY: ["YATZY_SUBMIT", "YATZY_IMPORT", "YATZY_MATCH_SET", "YATZY_CREATE"],
  BLACKJACK: ["BJ_BET_PLACED", "BJ_HAND_ACTION"],
  ROULETTE: ["ROULETTE_BET_PLACED"],
  TRIVIA: ["TRIVIA_CATEGORY_PICKED", "TRIVIA_ANSWER_SUBMITTED"],
  DICE: ["DICE_BET_PLACED"],
  MUSIC: ["MUSIC_GUESS_SUBMITTED"],
  HOLDEM: ["HOLDEM_ACTION_SUBMITTED"],
  RESULTS: [],
};

export const allowedClientEventsByStatus: Record<MatchStatus, ClientEventType[]> = {
  CREATED: ["MATCH_CREATE", "MATCH_JOIN", "MATCH_LEAVE", "READY_CHECK_CONFIRM"],
  RUNNING: [
    "YATZY_SUBMIT",
    "YATZY_IMPORT",
    "YATZY_MATCH_SET",
    "YATZY_CREATE",
    "BJ_BET_PLACED",
    "BJ_HAND_ACTION",
    "ROULETTE_BET_PLACED",
    "TRIVIA_CATEGORY_PICKED",
    "TRIVIA_ANSWER_SUBMITTED",
    "DICE_BET_PLACED",
    "MUSIC_GUESS_SUBMITTED",
    "HOLDEM_ACTION_SUBMITTED",
  ],
  COMPLETED: [],
  CANCELLED: [],
};

export const isClientEventAllowed = (params: {
  event: ClientEvent;
  stage: Stage;
  status: MatchStatus;
}): boolean => {
  const { event, stage, status } = params;
  const byStage = allowedClientEventsByStage[stage].includes(event.type);
  const byStatus = allowedClientEventsByStatus[status].includes(event.type);
  return byStage && byStatus;
};
