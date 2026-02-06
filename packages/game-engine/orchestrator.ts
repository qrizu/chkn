import { isClientEventAllowed } from "../shared/guards";
import type { ClientEvent, Match, MatchPlayer, MatchStatus, Stage } from "../shared/events";

export type OrchestratorContext = {
  match: Match;
  players: MatchPlayer[];
  stage: Stage;
  status: MatchStatus;
};

export type OrchestratorResult =
  | { ok: true; events: Array<{ type: string; payload: unknown }> }
  | { ok: false; error: string };

export class MatchOrchestrator {
  private ctx: OrchestratorContext;

  constructor(ctx: OrchestratorContext) {
    this.ctx = ctx;
  }

  getContext(): OrchestratorContext {
    return this.ctx;
  }

  // Entry point for all client events
  handleClientEvent(event: ClientEvent, userId: string): OrchestratorResult {
    if (!this.isPlayerInMatch(userId)) {
      return { ok: false, error: "not_in_match" };
    }

    if (!isClientEventAllowed({ event, stage: this.ctx.stage, status: this.ctx.status })) {
      return { ok: false, error: "event_not_allowed" };
    }

    return this.routeEvent(event);
  }

  // Server-side stage transitions
  startStage(nextStage: Stage): OrchestratorResult {
    if (!this.canTransitionTo(nextStage)) {
      return { ok: false, error: "invalid_stage_transition" };
    }
    this.ctx.stage = nextStage;
    return {
      ok: true,
      events: [
        { type: "STAGE_STARTED", payload: { matchId: this.ctx.match.id, stage: nextStage, ts: Date.now() } },
      ],
    };
  }

  completeStage(stage: Stage): OrchestratorResult {
    if (this.ctx.stage !== stage) {
      return { ok: false, error: "stage_mismatch" };
    }
    return {
      ok: true,
      events: [
        { type: "STAGE_COMPLETED", payload: { matchId: this.ctx.match.id, stage, ts: Date.now() } },
      ],
    };
  }

  private routeEvent(event: ClientEvent): OrchestratorResult {
    switch (event.type) {
      case "MATCH_CREATE":
      case "MATCH_JOIN":
      case "MATCH_LEAVE":
      case "READY_CHECK_CONFIRM":
        return { ok: true, events: [] };

      case "YATZY_SUBMIT":
        return { ok: true, events: [] };

      case "BJ_BET_PLACED":
      case "BJ_HAND_ACTION":
        return { ok: true, events: [] };

      case "ROULETTE_BET_PLACED":
        return { ok: true, events: [] };

      case "TRIVIA_CATEGORY_PICKED":
      case "TRIVIA_ANSWER_SUBMITTED":
        return { ok: true, events: [] };

      case "DICE_BET_PLACED":
        return { ok: true, events: [] };

      case "MUSIC_GUESS_SUBMITTED":
        return { ok: true, events: [] };

      case "HOLDEM_ACTION_SUBMITTED":
        return { ok: true, events: [] };

      default:
        return { ok: false, error: "unhandled_event" };
    }
  }

  private canTransitionTo(nextStage: Stage): boolean {
    const order: Stage[] = [
      "LOBBY",
      "YATZY",
      "BLACKJACK",
      "ROULETTE",
      "TRIVIA",
      "DICE",
      "MUSIC",
      "HOLDEM",
      "RESULTS",
    ];
    const currentIndex = order.indexOf(this.ctx.stage);
    const nextIndex = order.indexOf(nextStage);
    return nextIndex === currentIndex + 1;
  }

  private isPlayerInMatch(userId: string): boolean {
    return this.ctx.players.some((p) => p.userId === userId);
  }
}

