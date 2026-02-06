# Socket/HTTP Middleware Example (Node + Zod)

Detta visar hur du validerar inkommande events med Zod och stoppar felaktiga
payloads innan de nar game logic. Exemplet ar framework-agnostiskt och kan
anpassas till `ws`, `socket.io`, Fastify eller Express.

## 1) Enkel event-router (server side)

```ts
import { ClientEventSchema } from "../packages/shared/schemas";
import { isClientEventAllowed } from "../packages/shared/guards";

type Context = {
  matchId: string | null;
  stage: "LOBBY" | "YATZY" | "BLACKJACK" | "ROULETTE" | "TRIVIA" | "DICE" | "MUSIC" | "HOLDEM" | "RESULTS";
  status: "CREATED" | "RUNNING" | "COMPLETED" | "CANCELLED";
  userId: string;
};

export function handleClientEvent(rawPayload: unknown, ctx: Context) {
  const parsed = ClientEventSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return { ok: false, error: "invalid_payload", details: parsed.error.flatten() };
  }

  const event = parsed.data;
  if (!isClientEventAllowed({ event, stage: ctx.stage, status: ctx.status })) {
    return { ok: false, error: "event_not_allowed" };
  }

  // Route by event.type to your stage handlers
  return routeEvent(event, ctx);
}

function routeEvent(event: import("../packages/shared/schemas").ClientEvent, ctx: Context) {
  switch (event.type) {
    case "MATCH_CREATE":
      return { ok: true };
    case "YATZY_SUBMIT":
      return { ok: true };
    case "BJ_BET_PLACED":
      return { ok: true };
    default:
      return { ok: false, error: "unhandled_event" };
  }
}
```

## 2) Socket.IO wrapper (exempel)

```ts
io.on("connection", (socket) => {
  socket.on("event", (payload) => {
    const ctx = getContextForSocket(socket); // matchId, stage, status, userId
    const res = handleClientEvent(payload, ctx);

    if (!res.ok) {
      socket.emit("error", res);
      return;
    }
  });
});
```

## 3) HTTP fallback (exempel)

```ts
app.post("/api/event", (req, res) => {
  const ctx = getContextForRequest(req);
  const result = handleClientEvent(req.body, ctx);

  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json({ ok: true });
});
```

## Viktigt framover

- All validering sker fore stage logic.
- Inga clients far skapa egna poang eller state.
- Logga alltid avvisade events (för debugging).
