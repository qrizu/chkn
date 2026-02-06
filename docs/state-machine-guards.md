# CHKN State Machine Guards (v0.1)

## Server-authoritative rules

- Endast servern kan starta och avsluta stages.
- Endast servern kan uppdatera stack via ledger.
- Inga hopp framat mellan stages.
- Alla client events valideras mot aktiv stage och match status.

## Match status gates

- `CREATED`: endast lobby actions.
- `RUNNING`: endast stage actions.
- `COMPLETED` och `CANCELLED`: inga actions.

## Allowed client events per stage

LOBBY:
- `MATCH_CREATE`
- `MATCH_JOIN`
- `MATCH_LEAVE`
- `READY_CHECK_CONFIRM`

YATZY:
- `YATZY_SUBMIT`

BLACKJACK:
- `BJ_BET_PLACED`
- `BJ_HAND_ACTION`

ROULETTE:
- `ROULETTE_BET_PLACED`

TRIVIA:
- `TRIVIA_CATEGORY_PICKED`
- `TRIVIA_ANSWER_SUBMITTED`

DICE:
- `DICE_BET_PLACED`

MUSIC:
- `MUSIC_GUESS_SUBMITTED`

HOLDEM:
- `HOLDEM_ACTION_SUBMITTED`

RESULTS:
- inga client events

## Global validation

- Alla events maste innehalla `matchId` (utom `MATCH_CREATE`).
- `bet` maste vara heltal och positivt.
- Alla actions maste komma fran spelare som ar med i matchen.
- Rate limit pa svar/guess per stage.
