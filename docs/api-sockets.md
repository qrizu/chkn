# CHKN Realtime API/Socket Spec (v0.1)

Detta ar en konkret, minimal spec for hur klient och server pratar. Allt ar
server-authoritative: klienten skickar intents, servern skickar state och
beslut.

## Transport

- WebSocket (Socket.IO eller ws)
- Alla payloads ar JSON
- Alla tider ar server time (epoch ms)

## Envelope (rekommenderat)

Varje meddelande skickas i en standardform:

```
{
  "type": "EVENT_NAME",
  "payload": { ... }
}
```

## Server -> Client events

Match och lobby:

- `MATCH_CREATED` { match }
- `MATCH_JOINED` { matchId, userId }
- `MATCH_LEFT` { matchId, userId }
- `READY_CHECK_STARTED` { matchId }
- `READY_CHECK_PASSED` { matchId }
- `MATCH_COMPLETED` { matchId }

Stage control:

- `STAGE_STARTED` { matchId, stage, ts }
- `STAGE_COMPLETED` { matchId, stage, ts }
- `STAGE_STATE` { matchId, stage, state }

Ledger och stack:

- `LEDGER_ENTRY_APPLIED` { entry }
- `STACK_UPDATED` { matchId, userId, stack }

Stage-specifika:

Yatzy:

- `YATZY_PROMPT` { matchId, ts }

Blackjack:

- `BJ_ROUND_STARTED` { matchId, round, ts }
- `BJ_HAND_STATE` { matchId, round, spot, state }
- `BJ_ROUND_COMPLETED` { matchId, round, ts }

Roulette:

- `ROULETTE_OPEN` { matchId, bjProfit, ts }
- `ROULETTE_RESOLVED` { matchId, result, delta, ts }

Trivia:

- `TRIVIA_CATEGORY_OPTIONS` { matchId, options, ts }
- `TRIVIA_QUESTION_SHOWN` { matchId, question, ts, timeLimitMs }
- `TRIVIA_QUESTION_RESOLVED` { matchId, correctAnswerId, pointsByUser }

Dice:

- `DICE_FIRST_ROLL` { matchId, value, ts }
- `DICE_RESOLVED` { matchId, result, delta, ts }

Music:

- `MUSIC_ROUND_STARTED` { matchId, round, clipId, ts, timeLimitMs }
- `MUSIC_ROUND_RESOLVED` { matchId, correct, pointsByUser }

Holdem:

- `HOLDEM_HAND_STARTED` { matchId, handId, ts }
- `HOLDEM_ACTION_REQUIRED` { matchId, userId, minBet, ts }
- `HOLDEM_HAND_COMPLETED` { matchId, handId, deltasByUser }
- `HOLDEM_ORBIT_COMPLETED` { matchId, sb, bb, ts }

## Client -> Server events

Match och lobby:

- `MATCH_CREATE` { mode }
- `MATCH_JOIN` { matchId }
- `MATCH_LEAVE` { matchId }
- `READY_CHECK_CONFIRM` { matchId }

Yatzy:

- `YATZY_SUBMIT` { matchId, score }

Blackjack:

- `BJ_BET_PLACED` { matchId, round, spots, bet }
- `BJ_HAND_ACTION` { matchId, round, spot, action }

Roulette:

- `ROULETTE_BET_PLACED` { matchId, color, bet }

Trivia:

- `TRIVIA_CATEGORY_PICKED` { matchId, categoryId }
- `TRIVIA_ANSWER_SUBMITTED` { matchId, questionId, answerId }

Dice:

- `DICE_BET_PLACED` { matchId, choice, bet }

Music:

- `MUSIC_GUESS_SUBMITTED` { matchId, round, guess }

Holdem:

- `HOLDEM_ACTION_SUBMITTED` { matchId, action, amount? }

## Server-side thinking (vad som sker)

1. Servern skapar match och broadcastar `MATCH_CREATED`.
2. Spelare joinar och servern broadcastar `MATCH_JOINED`.
3. Ready-check -> `READY_CHECK_PASSED`.
4. Servern startar stage: `STAGE_STARTED` + stage-specifika prompts.
5. Klienter skickar actions. Servern validerar (guards + zod).
6. Servern raknar poang/utfall, skriver ledger, och broadcastar state.
7. `STAGE_COMPLETED` -> nasta stage.
8. `MATCH_COMPLETED` -> results.

## Hur du ska tanka framåt

- Ha en enda sanning: `MatchOrchestrator` server-side.
- All UI ar “dumb”: klienten fragar, servern beslutar.
- Logga allt som påverkar poang i `LedgerEntry`.
- Validera alla events med Zod + guards innan de hanteras.
- Bygg en stage i taget, men latt att byta mellan dem med `STAGE_STARTED`.

## Implementation tips

- Skapa en `EventBus` som tar emot client events och routar till stage handlers.
- Ge varje stage en tydlig `enter()` och `handle()` funktion.
- Returnera alltid `STAGE_STATE` efter ett muterande event.
