import { useEffect, useState } from "react";
import { socket } from "./socket";

type ServerEvent = { type: string; payload: any };

export default function App() {
  const [connected, setConnected] = useState(false);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [players, setPlayers] = useState<Array<{ userId: string; stack: number }>>([]);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [readySet, setReadySet] = useState<Set<string>>(new Set());
  const [yatzyMatchId, setYatzyMatchId] = useState("");
  const [yatzyImportStatus, setYatzyImportStatus] = useState<string | null>(null);
  const [stage, setStage] = useState<string>("LOBBY");
  const [hostUserId, setHostUserId] = useState<string | null>(null);
  const [yatzyCreateStatus, setYatzyCreateStatus] = useState<string | null>(null);
  const [authDebug, setAuthDebug] = useState<{ hasAuthentik: boolean; headers: string[] } | null>(null);

  useEffect(() => {
    addLog("ui_loaded");
    socket.on("connect", () => {
      setConnected(true);
      setSelfId(socket.id ?? null);
      addLog("connected");
    });
    socket.on("disconnect", () => {
      setConnected(false);
      addLog("disconnected");
    });
    socket.on("connect_error", (err) => {
      setLastError(err?.message ?? "connect_error");
      addLog(`connect_error: ${err?.message ?? "unknown"}`);
    });
    socket.on("event", (evt: ServerEvent) => {
      addLog(`event: ${evt.type}`);
      if (evt.type === "MATCH_STATE" && evt.payload) {
        if (Array.isArray(evt.payload.players)) setPlayers(evt.payload.players);
        if (Array.isArray(evt.payload.readyUserIds)) setReadySet(new Set(evt.payload.readyUserIds));
        if (evt.payload.matchId) setMatchId(evt.payload.matchId);
        if (evt.payload.stage) setStage(evt.payload.stage);
        if (evt.payload.hostUserId) setHostUserId(evt.payload.hostUserId);
        if (evt.payload.yatzyMatchId) setYatzyMatchId(evt.payload.yatzyMatchId);
      }
      if (evt.type === "MATCH_CREATED" && evt.payload?.match?.id) {
        setMatchId(evt.payload.match.id);
      }
      if (evt.type === "MATCH_JOINED" && evt.payload?.matchId && evt.payload?.userId) {
        if (evt.payload.userId === socket.id) {
          setMatchId(evt.payload.matchId);
        }
      }
      if (evt.type === "MATCH_JOINED" && evt.payload?.userId) {
        setPlayers((prev) => {
          if (prev.some((p) => p.userId === evt.payload.userId)) return prev;
          return [...prev, { userId: evt.payload.userId, stack: 0 }];
        });
      }
      if (evt.type === "MATCH_LEFT" && evt.payload?.userId) {
        setPlayers((prev) => prev.filter((p) => p.userId !== evt.payload.userId));
      }
      if (evt.type === "READY_UPDATED" && Array.isArray(evt.payload?.readyUserIds)) {
        setReadySet(new Set(evt.payload.readyUserIds));
      }
      if (evt.type === "YATZY_IMPORTED") {
        setYatzyImportStatus(`Import klar: ${evt.payload?.yatzyMatchId ?? ""}`.trim());
      }
      if (evt.type === "YATZY_MATCH_SET" && evt.payload?.yatzyMatchId) {
        setYatzyMatchId(evt.payload.yatzyMatchId);
      }
      if (evt.type === "YATZY_MATCH_CREATED" && evt.payload?.yatzyMatchId) {
        setYatzyMatchId(evt.payload.yatzyMatchId);
        setYatzyCreateStatus("Yatzy-match skapad");
      }
      if (evt.type === "AUTH_DEBUG") {
        setAuthDebug({
          hasAuthentik: !!evt.payload?.hasAuthentik,
          headers: Array.isArray(evt.payload?.headers) ? evt.payload.headers : [],
        });
      }
      if (evt.type === "STAGE_STARTED" && evt.payload?.stage) {
        setStage(evt.payload.stage);
      }
    });
    socket.onAny((eventName) => {
      addLog(`onAny: ${eventName}`);
    });
    socket.on("error", (err) => {
      setLastError(JSON.stringify(err));
      addLog(`error: ${JSON.stringify(err)}`);
      if (typeof err?.error === "string" && err.error === "yatzy_import_failed") {
        setYatzyImportStatus("Import misslyckades");
      }
      if (typeof err?.error === "string" && err.error === "yatzy_create_failed") {
        setYatzyCreateStatus("Skapande misslyckades");
      }
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("connect_error");
      socket.off("event");
      socket.off("error");
      socket.offAny();
    };
  }, [socket]);

  const addLog = (line: string) => {
    setLog((prev) => [line, ...prev].slice(0, 6));
  };

  const createMatch = () => {
    if (!connected) {
      addLog("not_connected");
      return;
    }
    socket.emit("event", { type: "MATCH_CREATE", mode: "FIVE_KAMP" });
    addLog("sent: MATCH_CREATE");
  };

  const readyUp = () => {
    if (!matchId) return;
    socket.emit("event", { type: "READY_CHECK_CONFIRM", matchId });
    addLog("sent: READY_CHECK_CONFIRM");
  };

  const joinMatch = () => {
    const code = joinCode.trim();
    if (!code) return;
    socket.emit("event", { type: "MATCH_JOIN", matchId: code });
    addLog("sent: MATCH_JOIN");
  };

  const importYatzy = () => {
    const id = yatzyMatchId.trim();
    if (!matchId || !id) return;
    socket.emit("event", { type: "YATZY_IMPORT", matchId, yatzyMatchId: id });
    setYatzyImportStatus("Importerar...");
    addLog("sent: YATZY_IMPORT");
  };

  const setYatzyMatch = () => {
    const id = yatzyMatchId.trim();
    if (!matchId || !id) return;
    socket.emit("event", { type: "YATZY_MATCH_SET", matchId, yatzyMatchId: id });
    addLog("sent: YATZY_MATCH_SET");
  };

  const createYatzyMatch = () => {
    if (!matchId) return;
    socket.emit("event", { type: "YATZY_CREATE", matchId });
    setYatzyCreateStatus("Skapar...");
    addLog("sent: YATZY_CREATE");
  };

  return (
    <main className="app">
      <header className="hero">
        <p className="eyebrow">CHKN</p>
        <h1>Chicken Race</h1>
        <p className="lead">
          Real-time utmaningar. 5-kamp med Yatzy, Black Jack, Trivia, Musikquiz
          och Texas Hold'em. Servern ar domare.
        </p>
        <div className="cta-row">
          <button className="btn-primary" onClick={createMatch} disabled={!connected}>
            Skapa match
          </button>
          <div className="join-row">
            <input
              className="join-input"
              placeholder="Match-kod"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
            />
            <button className="btn-ghost" onClick={joinMatch} disabled={!connected}>
              Join
            </button>
          </div>
          <button className="btn-ghost" onClick={readyUp} disabled={!matchId}>
            Ready
          </button>
        </div>
        <div className="import-row">
          <input
            className="join-input"
            placeholder="Yatzy match-id"
            value={yatzyMatchId}
            onChange={(e) => setYatzyMatchId(e.target.value)}
          />
          <button
            className="btn-ghost"
            onClick={setYatzyMatch}
            disabled={!matchId || !yatzyMatchId.trim() || selfId !== hostUserId}
            title={selfId !== hostUserId ? "Endast host kan sätta match" : ""}
          >
            Sätt Yatzy match
          </button>
          <button
            className="btn-ghost"
            onClick={createYatzyMatch}
            disabled={!matchId || selfId !== hostUserId}
            title={selfId !== hostUserId ? "Endast host kan skapa match" : ""}
          >
            Skapa Yatzy match
          </button>
          <button className="btn-ghost" onClick={importYatzy} disabled={!matchId || !yatzyMatchId.trim()}>
            Importera Yatzy
          </button>
          {yatzyImportStatus ? <span className="status">{yatzyImportStatus}</span> : null}
          {yatzyCreateStatus ? <span className="status">{yatzyCreateStatus}</span> : null}
        </div>
        {yatzyMatchId ? (
          <div className="import-row">
            <a
              className="btn-link"
              href={`https://ytzy-dev.sputnet.space/#/m/${yatzyMatchId}`}
              target="_blank"
              rel="noreferrer"
            >
              Öppna Yatzy match
            </a>
          </div>
        ) : null}
        <div className="status-row">
          <span className={connected ? "status ok" : "status bad"}>
            {connected ? "Online" : "Offline"}
          </span>
          <span className="status">{matchId ? `Match: ${matchId}` : "No match"}</span>
          {lastError ? <span className="status bad">Error: {lastError}</span> : null}
          <span className="status">Log entries: {log.length}</span>
          <span className="status">{selfId ? `You: ${selfId}` : "You: - "}</span>
          <span className="status">Stage: {stage}</span>
          <span className="status">Host: {hostUserId ? hostUserId : "-"}</span>
        </div>
      </header>
      <section className="cards">
        <article className="card">
          <h2>5-kamp</h2>
          <p>Allt ackumuleras i CHKN-poang. Vinn overall med smart spel.</p>
        </article>
        <article className="card">
          <h2>Chicken Run</h2>
          <p>Snabb vadslagning for max nerv.</p>
        </article>
        <article className="card">
          <h2>Sputnik</h2>
          <p>Spela solo mot AI-botten som aldrig blinkar.</p>
        </article>
      </section>
      <section className="log">
        <h3>Realtime log</h3>
        <ul>
          {log.map((line, i) => (
            <li key={`${line}-${i}`}>{line}</li>
          ))}
        </ul>
      </section>
      <section className="players">
        <h3>Spelare</h3>
        {players.length === 0 ? (
          <p>Inga spelare anslutna.</p>
        ) : (
          <ul>
            {players.map((p, idx) => {
              const isReady = readySet.has(p.userId);
              const seat = ["P1", "P2", "P3", "P4", "P5", "P6"][idx] ?? "-";
              return (
                <li key={p.userId}>
                  <span className={isReady ? "ready-chip" : "ready-chip off"}>
                    {isReady ? "Ready" : "Not ready"}
                  </span>
                  <span className="player-seat">{seat}</span>
                  <span className="player-id">{p.userId}</span>
                  <span className="player-stack">Stack: {p.stack}</span>
                  <span className="you-tag">{selfId === p.userId ? "(Du)" : ""}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="debug">
        <h3>Debug: Authentik</h3>
        {authDebug ? (
          <div>
            <p>
              Inloggning: <strong>{authDebug.hasAuthentik ? "OK" : "Saknas"}</strong>
            </p>
            <p>Headers: {authDebug.headers.length ? authDebug.headers.join(", ") : "inga"}</p>
          </div>
        ) : (
          <p>Ingen debug-data mottagen.</p>
        )}
      </section>
    </main>
  );
}
