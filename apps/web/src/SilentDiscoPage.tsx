import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { socket } from "./socket";

type SilentDiscoPageProps = {
  appBasePath: string;
  appHref: (path: string) => string;
  tr: (sv: string, en: string) => string;
  displayName: string;
};

type SilentDiscoUser = {
  userId: string;
  username: string | null;
  displayName: string;
  email: string | null;
};

type SilentDiscoSourceKind = "upload" | "stream" | "spotify" | "soundcloud";

type JoinLinkRole = "listener" | "host";

type SilentDiscoSource = {
  kind: SilentDiscoSourceKind;
  title: string;
  url: string;
  mimeType: string | null;
  mediaId: string | null;
  setByUserId: string;
};

type SilentDiscoRoomState = {
  roomCode: string;
  hostUserId: string;
  hostDisplayName: string;
  source: SilentDiscoSource | null;
  playing: boolean;
  positionMs: number;
  serverNowMs: number;
  listenerCount: number;
  listenerUserCount: number;
  listeners: Array<{ userId: string; displayName: string }>;
};

type UploadResponse = {
  ok: boolean;
  error?: string;
  media?: {
    id: string;
    url: string;
    mimeType: string;
    sizeBytes: number;
    originalName: string;
  };
};

type LinkResponse = {
  ok: boolean;
  error?: string;
  token?: string;
  roomCode?: string;
  role?: JoinLinkRole;
  expiresInSeconds?: number;
};

const MAX_UPLOAD_SIZE_MB = 80;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

const isPlayableSource = (source: SilentDiscoSource | null): boolean => {
  if (!source) return false;
  return source.kind === "upload" || source.kind === "stream";
};

const normalizeRoomInput = (value: string): string =>
  String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);

const normalizeHttpUrl = (value: string): string => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
};

const toAbsoluteUrl = (url: string): string => {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  const normalized = url.startsWith("/") ? url : `/${url}`;
  return `${window.location.origin}${normalized}`;
};

const normalizeRole = (value: unknown): JoinLinkRole =>
  String(value || "listener").trim().toLowerCase() === "host" ? "host" : "listener";

const resolveSilentDiscoEntryPath = (appBasePath: string): string =>
  appBasePath === "/silent-disco" ? "/" : "/silent-disco";

export default function SilentDiscoPage({ appBasePath, appHref, tr, displayName }: SilentDiscoPageProps) {
  const initialJoinData = useMemo(() => {
    const params = new URLSearchParams(window.location.search || "");
    return {
      roomCode: normalizeRoomInput(params.get("room") || ""),
      token: String(params.get("token") || "").trim(),
    };
  }, []);

  const [me, setMe] = useState<SilentDiscoUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [roomInput, setRoomInput] = useState(initialJoinData.roomCode || "");
  const [room, setRoom] = useState<SilentDiscoRoomState | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [streamTitle, setStreamTitle] = useState("");
  const [streamUrl, setStreamUrl] = useState("");
  const [linkKind, setLinkKind] = useState<SilentDiscoSourceKind>("stream");
  const [audioReady, setAudioReady] = useState(false);
  const [joinToken, setJoinToken] = useState(initialJoinData.token || "");
  const [autoJoinAttempted, setAutoJoinAttempted] = useState(false);
  const [linkBusyRole, setLinkBusyRole] = useState<JoinLinkRole | null>(null);
  const [guestJoinUrl, setGuestJoinUrl] = useState("");
  const [hostJoinUrl, setHostJoinUrl] = useState("");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const silentDiscoEntryPath = useMemo(() => resolveSilentDiscoEntryPath(appBasePath), [appBasePath]);

  const apiBaseUrl = useMemo(() => {
    const configured = (import.meta.env.VITE_API_URL || "").trim();
    if (!configured) {
      return `${window.location.origin}${appBasePath}/api`;
    }
    const clean = configured.replace(/\/$/, "");
    if (clean.endsWith("/api")) {
      return /^https?:\/\//i.test(clean) ? clean : `${window.location.origin}${clean.startsWith("/") ? clean : `/${clean}`}`;
    }
    const withApi = `${clean}/api`;
    return /^https?:\/\//i.test(withApi)
      ? withApi
      : `${window.location.origin}${withApi.startsWith("/") ? withApi : `/${withApi}`}`;
  }, [appBasePath]);

  const isHost = useMemo(() => {
    if (!room || !me?.userId) return false;
    return room.hostUserId === me.userId;
  }, [me?.userId, room]);

  const buildJoinUrl = useCallback(
    (roomCode: string, token: string) => {
      const params = new URLSearchParams();
      params.set("room", roomCode);
      if (token) params.set("token", token);
      const pathWithQuery = `${silentDiscoEntryPath}?${params.toString()}`;
      return `${window.location.origin}${appHref(pathWithQuery)}`;
    },
    [appHref, silentDiscoEntryPath]
  );

  const plainRoomJoinUrl = useMemo(() => {
    if (!room?.roomCode) return "";
    return buildJoinUrl(room.roomCode, "");
  }, [buildJoinUrl, room?.roomCode]);

  const guestQrUrl = useMemo(
    () => (guestJoinUrl ? `https://quickchart.io/qr?size=260&text=${encodeURIComponent(guestJoinUrl)}` : ""),
    [guestJoinUrl]
  );
  const hostQrUrl = useMemo(
    () => (hostJoinUrl ? `https://quickchart.io/qr?size=260&text=${encodeURIComponent(hostJoinUrl)}` : ""),
    [hostJoinUrl]
  );

  const clearJoinParamsFromUrl = useCallback(() => {
    const url = new URL(window.location.href);
    let changed = false;
    if (url.searchParams.has("room")) {
      url.searchParams.delete("room");
      changed = true;
    }
    if (url.searchParams.has("token")) {
      url.searchParams.delete("token");
      changed = true;
    }
    if (changed) {
      const next = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState({}, "", next);
    }
  }, []);

  const copyText = useCallback(
    async (value: string) => {
      const text = String(value || "").trim();
      if (!text) return;
      try {
        if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
        await navigator.clipboard.writeText(text);
        setStatus(tr("Länk kopierad.", "Link copied."));
      } catch {
        setError(tr("Kunde inte kopiera länken automatiskt.", "Could not copy link automatically."));
      }
    },
    [tr]
  );

  const fetchMe = useCallback(async () => {
    setAuthError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/silent-disco/me`, {
        method: "GET",
        credentials: "include",
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || !data?.user) {
        setMe(null);
        setAuthError(tr("Du behöver logga in för att använda Silent Disco.", "You need to sign in to use Silent Disco."));
      } else {
        setMe(data.user as SilentDiscoUser);
      }
    } catch {
      setMe(null);
      setAuthError(tr("Kunde inte verifiera inloggning just nu.", "Could not verify sign-in right now."));
    } finally {
      setAuthChecked(true);
    }
  }, [apiBaseUrl, tr]);

  useEffect(() => {
    void fetchMe();
  }, [fetchMe]);

  useEffect(() => {
    const onRoomState = (payload: any) => {
      if (!payload?.room) return;
      const nextRoom = payload.room as SilentDiscoRoomState;
      setRoom(nextRoom);
      setRoomInput(nextRoom.roomCode || "");
      setStatus(
        tr(
          `Rum ${nextRoom.roomCode} synkat. ${nextRoom.listenerUserCount} lyssnare anslutna.`,
          `Room ${nextRoom.roomCode} synced. ${nextRoom.listenerUserCount} listeners connected.`
        )
      );
      setError(null);
    };

    const onRoomCreated = (payload: any) => {
      if (!payload?.room) return;
      const nextRoom = payload.room as SilentDiscoRoomState;
      setRoom(nextRoom);
      setRoomInput(nextRoom.roomCode || "");
      setStatus(
        tr(
          `Rum ${nextRoom.roomCode} skapat. Dela länk eller QR med dina vänner.`,
          `Room ${nextRoom.roomCode} created. Share link or QR with your friends.`
        )
      );
      setError(null);
    };

    const onJoined = (payload: any) => {
      if (!payload?.room) return;
      const nextRoom = payload.room as SilentDiscoRoomState;
      setRoom(nextRoom);
      setRoomInput(nextRoom.roomCode || "");
      setStatus(tr(`Ansluten till rum ${nextRoom.roomCode}.`, `Joined room ${nextRoom.roomCode}.`));
      setError(null);
      clearJoinParamsFromUrl();
    };

    const onLeft = () => {
      setRoom(null);
      setStatus(tr("Du lämnade rummet.", "You left the room."));
      setError(null);
    };

    const onDiscoError = (payload: any) => {
      const code = String(payload?.error || "unknown_error");
      const translated = (() => {
        switch (code) {
          case "unauthorized":
            return tr("Du måste vara inloggad.", "You must be signed in.");
          case "room_not_found":
            return tr("Rummet hittades inte.", "Room not found.");
          case "only_host":
            return tr("Bara hosten kan styra uppspelningen.", "Only the host can control playback.");
          case "source_missing":
            return tr("Lägg till en ljudkälla först.", "Add an audio source first.");
          case "invalid_source_url":
            return tr("Ogiltig URL för ljudkälla.", "Invalid source URL.");
          case "invalid_upload_source":
            return tr("Uppladdad källa kunde inte hittas.", "Uploaded source could not be found.");
          case "spotify_url_required":
            return tr("Ange en giltig Spotify-länk.", "Provide a valid Spotify URL.");
          case "soundcloud_url_required":
            return tr("Ange en giltig SoundCloud-länk.", "Provide a valid SoundCloud URL.");
          case "missing_room_code":
            return tr("Ange en rumskod.", "Enter a room code.");
          case "join_token_invalid":
            return tr("Join-token är ogiltig.", "Join token is invalid.");
          case "join_token_expired":
            return tr("Join-token har gått ut.", "Join token has expired.");
          case "join_token_room_mismatch":
            return tr("Join-token matchar inte detta rum.", "Join token does not match this room.");
          case "join_token_user_mismatch":
            return tr("Host-token tillhör ett annat konto.", "Host token belongs to another account.");
          case "only_host_can_generate_link":
            return tr("Bara hosten kan skapa join-länkar.", "Only the host can generate join links.");
          default:
            return tr(`Silent Disco-fel: ${code}`, `Silent Disco error: ${code}`);
        }
      })();
      setError(translated);
    };

    socket.on("silent_disco:state", onRoomState);
    socket.on("silent_disco:room_created", onRoomCreated);
    socket.on("silent_disco:joined", onJoined);
    socket.on("silent_disco:left", onLeft);
    socket.on("silent_disco:error", onDiscoError);

    return () => {
      socket.off("silent_disco:state", onRoomState);
      socket.off("silent_disco:room_created", onRoomCreated);
      socket.off("silent_disco:joined", onJoined);
      socket.off("silent_disco:left", onLeft);
      socket.off("silent_disco:error", onDiscoError);
    };
  }, [clearJoinParamsFromUrl, tr]);

  useEffect(() => {
    if (autoJoinAttempted) return;
    if (!authChecked || !me) return;
    const roomCode = initialJoinData.roomCode;
    if (!roomCode) return;

    const joinViaLink = () => {
      setStatus(tr("Ansluter via delad länk...", "Joining via shared link..."));
      socket.emit("silent_disco:join_room", {
        roomCode,
        ...(initialJoinData.token ? { token: initialJoinData.token } : {}),
      });
      setAutoJoinAttempted(true);
    };

    if (socket.connected) {
      joinViaLink();
      return;
    }

    socket.once("connect", joinViaLink);
    return () => {
      socket.off("connect", joinViaLink);
    };
  }, [authChecked, autoJoinAttempted, initialJoinData.roomCode, initialJoinData.token, me, tr]);

  const syncAudioToRoom = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const source = room?.source || null;

    if (!room || !source || (source.kind !== "upload" && source.kind !== "stream")) {
      if (!audio.paused) {
        audio.pause();
      }
      if (audio.src) {
        audio.removeAttribute("src");
        audio.load();
      }
      return;
    }

    const sourceUrl = toAbsoluteUrl(source.url);
    if (!sourceUrl) return;

    if (audio.dataset.discoSource !== sourceUrl) {
      audio.dataset.discoSource = sourceUrl;
      audio.src = sourceUrl;
      audio.load();
      setAudioReady(false);
      return;
    }

    const serverNowMs = Number(room.serverNowMs || Date.now());
    const targetPositionMs = room.playing
      ? Math.max(0, room.positionMs + Math.max(0, Date.now() - serverNowMs))
      : Math.max(0, room.positionMs);
    const targetSeconds = targetPositionMs / 1000;

    if (audioReady && Number.isFinite(audio.currentTime)) {
      const drift = Math.abs(audio.currentTime - targetSeconds);
      if (drift > 0.35) {
        try {
          audio.currentTime = targetSeconds;
        } catch {
          // ignore seek errors from still-loading streams
        }
      }
    }

    if (room.playing) {
      if (audio.paused) {
        void audio.play().catch(() => {
          // On some browsers autoplay policy blocks until user gesture.
        });
      }
    } else if (!audio.paused) {
      audio.pause();
    }
  }, [audioReady, room]);

  useEffect(() => {
    syncAudioToRoom();
  }, [syncAudioToRoom]);

  useEffect(() => {
    if (!room) return;
    const timer = window.setInterval(() => {
      syncAudioToRoom();
    }, 1200);
    return () => {
      window.clearInterval(timer);
    };
  }, [room?.roomCode, syncAudioToRoom]);

  const requestFreshState = useCallback(() => {
    const roomCode = normalizeRoomInput(room?.roomCode || roomInput);
    if (!roomCode) return;
    socket.emit("silent_disco:request_state", { roomCode });
  }, [room?.roomCode, roomInput]);

  const createRoom = useCallback(() => {
    setStatus(tr("Skapar rum...", "Creating room..."));
    setError(null);
    setGuestJoinUrl("");
    setHostJoinUrl("");
    socket.emit("silent_disco:create_room");
  }, [tr]);

  const joinRoom = useCallback(() => {
    const roomCode = normalizeRoomInput(roomInput);
    if (!roomCode) {
      setError(tr("Ange en giltig rumskod.", "Enter a valid room code."));
      return;
    }
    setStatus(tr("Ansluter till rum...", "Joining room..."));
    setError(null);
    const token = String(joinToken || "").trim();
    socket.emit("silent_disco:join_room", {
      roomCode,
      ...(token ? { token } : {}),
    });
  }, [joinToken, roomInput, tr]);

  const leaveRoom = useCallback(() => {
    socket.emit("silent_disco:leave_room");
  }, []);

  const emitSource = useCallback(
    (source: { kind: SilentDiscoSourceKind; title: string; url: string; mimeType?: string | null }) => {
      if (!room?.roomCode) {
        setError(tr("Skapa eller gå med i ett rum först.", "Create or join a room first."));
        return;
      }
      socket.emit("silent_disco:set_source", {
        roomCode: room.roomCode,
        source: {
          kind: source.kind,
          title: source.title,
          url: source.url,
          mimeType: source.mimeType ?? null,
        },
      });
    },
    [room?.roomCode, tr]
  );

  const onUploadPicked = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (file.size > MAX_UPLOAD_SIZE_MB * 1024 * 1024) {
        setError(
          tr(
            `Filen är för stor. Max ${MAX_UPLOAD_SIZE_MB} MB.`,
            `File is too large. Max ${MAX_UPLOAD_SIZE_MB} MB.`
          )
        );
        return;
      }

      if (!room?.roomCode) {
        setError(tr("Skapa eller gå med i ett rum först.", "Create or join a room first."));
        return;
      }

      setUploadBusy(true);
      setError(null);
      setStatus(tr("Laddar upp ljudfil...", "Uploading audio file..."));

      try {
        const dataUrl = await readFileAsDataUrl(file);
        const response = await fetch(`${apiBaseUrl}/silent-disco/upload`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: file.name,
            mimeType: file.type,
            dataUrl,
          }),
        });
        const payload = (await response.json().catch(() => null)) as UploadResponse | null;
        if (!response.ok || !payload?.ok || !payload.media?.url) {
          setError(tr("Uppladdning misslyckades.", "Upload failed."));
          return;
        }

        emitSource({
          kind: "upload",
          title: file.name,
          url: payload.media.url,
          mimeType: payload.media.mimeType,
        });

        setStatus(
          tr(
            `Klar: ${file.name} är nu vald som källa.`,
            `Done: ${file.name} is now selected as source.`
          )
        );
      } catch {
        setError(tr("Kunde inte ladda upp filen.", "Could not upload the file."));
      } finally {
        setUploadBusy(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [apiBaseUrl, emitSource, room?.roomCode, tr]
  );

  const setLinkSource = useCallback(() => {
    if (!room?.roomCode) {
      setError(tr("Skapa eller gå med i ett rum först.", "Create or join a room first."));
      return;
    }

    const url = normalizeHttpUrl(streamUrl);
    if (!url) {
      setError(tr("Ange en giltig URL.", "Enter a valid URL."));
      return;
    }

    const title = streamTitle.trim() || url;
    emitSource({
      kind: linkKind,
      title,
      url,
      mimeType: null,
    });

    setStatus(tr("Källa uppdaterad.", "Source updated."));
  }, [emitSource, linkKind, room?.roomCode, streamTitle, streamUrl, tr]);

  const createJoinLink = useCallback(
    async (role: JoinLinkRole) => {
      if (!room?.roomCode) {
        setError(tr("Skapa eller gå med i ett rum först.", "Create or join a room first."));
        return;
      }
      if (!isHost) {
        setError(tr("Bara hosten kan skapa join-länkar.", "Only host can create join links."));
        return;
      }

      setLinkBusyRole(role);
      setError(null);

      try {
        const response = await fetch(`${apiBaseUrl}/silent-disco/link`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roomCode: room.roomCode, role }),
        });

        const payload = (await response.json().catch(() => null)) as LinkResponse | null;
        if (!response.ok || !payload?.ok || !payload.token) {
          setError(tr("Kunde inte skapa join-länk.", "Could not create join link."));
          return;
        }

        const nextRole = normalizeRole(payload.role || role);
        const url = buildJoinUrl(room.roomCode, payload.token);
        if (nextRole === "host") {
          setHostJoinUrl(url);
          setStatus(tr("Host-länk skapad.", "Host link created."));
        } else {
          setGuestJoinUrl(url);
          setStatus(tr("Gästlänk skapad.", "Guest link created."));
        }
      } catch {
        setError(tr("Kunde inte skapa join-länk.", "Could not create join link."));
      } finally {
        setLinkBusyRole(null);
      }
    },
    [apiBaseUrl, buildJoinUrl, isHost, room?.roomCode, tr]
  );

  const getAudioPositionMs = useCallback((): number => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.currentTime)) return 0;
    return Math.max(0, Math.round(audio.currentTime * 1000));
  }, []);

  const playForEveryone = useCallback(() => {
    if (!room?.roomCode) return;
    socket.emit("silent_disco:play", {
      roomCode: room.roomCode,
      positionMs: getAudioPositionMs(),
    });
  }, [getAudioPositionMs, room?.roomCode]);

  const pauseForEveryone = useCallback(() => {
    if (!room?.roomCode) return;
    socket.emit("silent_disco:pause", {
      roomCode: room.roomCode,
      positionMs: getAudioPositionMs(),
    });
  }, [getAudioPositionMs, room?.roomCode]);

  const seekBy = useCallback(
    (deltaSeconds: number) => {
      if (!room?.roomCode) return;
      const audio = audioRef.current;
      const current = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : room.positionMs / 1000;
      const next = Math.max(0, current + deltaSeconds);
      if (audio) {
        try {
          audio.currentTime = next;
        } catch {
          // ignore seek errors while metadata still loading
        }
      }
      socket.emit("silent_disco:seek", {
        roomCode: room.roomCode,
        positionMs: Math.round(next * 1000),
      });
    },
    [room?.positionMs, room?.roomCode]
  );

  const currentSource = room?.source || null;
  const playableSource = isPlayableSource(currentSource);

  return (
    <section className="profile-card silentDiscoPanel">
      <div className="profile-header">
        <div>
          <p className="eyebrow">SILENT DISCO</p>
          <h2>{tr("Synkad lyssning i realtid", "Realtime synced listening")}</h2>
          <p className="lead">
            {tr(
              "Skapa ett rum, välj ljudkälla och låt alla lyssna synkat från mobilen.",
              "Create a room, choose an audio source, and let everyone listen in sync from mobile."
            )}
          </p>
        </div>
        <div className="profile-badge">
          <span>{socket.connected ? tr("Socket online", "Socket online") : tr("Socket offline", "Socket offline")}</span>
        </div>
      </div>

      {!authChecked ? <p className="status">{tr("Verifierar inloggning...", "Checking sign-in...")}</p> : null}
      {authError ? <p className="status bad">{authError}</p> : null}

      {me ? (
        <div className="silentDiscoLoginRow">
          <span className="status ok">
            {tr("Inloggad som", "Signed in as")}: {me.displayName || displayName}
          </span>
          <a className="btn-link" href={appHref("/profile")}>
            {tr("Profil", "Profile")}
          </a>
        </div>
      ) : null}

      <div className="silentDiscoRoomRow">
        <button className="btn-primary" type="button" onClick={createRoom} disabled={!me}>
          {tr("Skapa rum", "Create room")}
        </button>

        <div className="join-row silentDiscoJoinRow">
          <input
            className="join-input"
            placeholder={tr("Rumskod", "Room code")}
            value={roomInput}
            onChange={(e) => setRoomInput(normalizeRoomInput(e.target.value))}
            disabled={!me}
          />
          <button className="btn-ghost" type="button" onClick={joinRoom} disabled={!me || roomInput.length < 4}>
            {tr("Gå med", "Join")}
          </button>
          <button className="btn-ghost" type="button" onClick={leaveRoom} disabled={!room}>
            {tr("Lämna", "Leave")}
          </button>
        </div>
      </div>

      <input
        className="join-input silentDiscoJoinTokenInput"
        placeholder={tr("Join-token (valfritt, från QR/länk)", "Join token (optional, from QR/link)")}
        value={joinToken}
        onChange={(e) => setJoinToken(e.target.value)}
        disabled={!me}
      />

      {room ? (
        <article className="summary-card silentDiscoRoomCard">
          <div className="summary-card-header silentDiscoRoomHead">
            <h3>{tr("Aktivt rum", "Active room")}</h3>
            <span className="silentDiscoCode">{room.roomCode}</span>
          </div>

          <div className="silentDiscoMetaGrid">
            <p>
              <strong>{tr("Host", "Host")}:</strong> {room.hostDisplayName}
            </p>
            <p>
              <strong>{tr("Lyssnare", "Listeners")}:</strong> {room.listenerUserCount}
            </p>
            <p>
              <strong>{tr("Status", "Status")}:</strong> {room.playing ? tr("Spelar", "Playing") : tr("Pausad", "Paused")}
            </p>
            <p>
              <strong>{tr("Källa", "Source")}:</strong> {currentSource ? currentSource.title : tr("Ingen vald", "No source selected")}
            </p>
          </div>

          <audio
            ref={audioRef}
            className="silentDiscoAudio"
            controls
            preload="auto"
            onLoadedMetadata={() => setAudioReady(true)}
            onCanPlay={() => setAudioReady(true)}
          />

          <div className="silentDiscoControls">
            <button className="btn-ghost" type="button" onClick={requestFreshState}>
              {tr("Synka nu", "Sync now")}
            </button>
            <button className="btn-primary" type="button" onClick={playForEveryone} disabled={!isHost || !playableSource}>
              {tr("Spela för alla", "Play for everyone")}
            </button>
            <button className="btn-ghost" type="button" onClick={pauseForEveryone} disabled={!isHost || !playableSource}>
              {tr("Pausa för alla", "Pause for everyone")}
            </button>
            <button className="btn-ghost" type="button" onClick={() => seekBy(-10)} disabled={!isHost || !playableSource}>
              {tr("-10 sek", "-10 sec")}
            </button>
            <button className="btn-ghost" type="button" onClick={() => seekBy(10)} disabled={!isHost || !playableSource}>
              {tr("+10 sek", "+10 sec")}
            </button>
          </div>

          {isHost ? (
            <div className="silentDiscoShareBlock">
              <div className="silentDiscoShareButtons">
                <button
                  className="btn-primary"
                  type="button"
                  onClick={() => createJoinLink("listener")}
                  disabled={linkBusyRole !== null}
                >
                  {linkBusyRole === "listener" ? tr("Skapar gästlänk...", "Creating guest link...") : tr("Skapa gästlänk", "Create guest link")}
                </button>
                <button
                  className="btn-ghost"
                  type="button"
                  onClick={() => createJoinLink("host")}
                  disabled={linkBusyRole !== null}
                >
                  {linkBusyRole === "host" ? tr("Skapar host-länk...", "Creating host link...") : tr("Skapa host-länk", "Create host link")}
                </button>
                <button className="btn-ghost" type="button" onClick={() => copyText(plainRoomJoinUrl)}>
                  {tr("Kopiera enkel rumslänk", "Copy plain room link")}
                </button>
              </div>

              {guestJoinUrl ? (
                <div className="silentDiscoShareRow">
                  <label>{tr("Gästlänk", "Guest link")}</label>
                  <div className="silentDiscoShareInputRow">
                    <input className="silentDiscoShareInput" value={guestJoinUrl} readOnly />
                    <button className="btn-ghost" type="button" onClick={() => copyText(guestJoinUrl)}>
                      {tr("Kopiera", "Copy")}
                    </button>
                  </div>
                </div>
              ) : null}

              {hostJoinUrl ? (
                <div className="silentDiscoShareRow">
                  <label>{tr("Host-länk", "Host link")}</label>
                  <div className="silentDiscoShareInputRow">
                    <input className="silentDiscoShareInput" value={hostJoinUrl} readOnly />
                    <button className="btn-ghost" type="button" onClick={() => copyText(hostJoinUrl)}>
                      {tr("Kopiera", "Copy")}
                    </button>
                  </div>
                </div>
              ) : null}

              {(guestQrUrl || hostQrUrl) ? (
                <div className="silentDiscoQrWrap">
                  {guestQrUrl ? (
                    <figure className="silentDiscoQrCard">
                      <img className="silentDiscoQrImage" src={guestQrUrl} alt={tr("QR för gästlänk", "QR for guest link")} loading="lazy" />
                      <figcaption>{tr("Gäst-QR", "Guest QR")}</figcaption>
                    </figure>
                  ) : null}
                  {hostQrUrl ? (
                    <figure className="silentDiscoQrCard">
                      <img className="silentDiscoQrImage" src={hostQrUrl} alt={tr("QR för host-länk", "QR for host link")} loading="lazy" />
                      <figcaption>{tr("Host-QR", "Host QR")}</figcaption>
                    </figure>
                  ) : null}
                </div>
              ) : null}

              {(guestQrUrl || hostQrUrl) ? (
                <p className="help-text">
                  {tr(
                    "QR-koden renderas via en extern QR-tjänst (quickchart.io).",
                    "The QR image is rendered through an external QR service (quickchart.io)."
                  )}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="summary-detail">
              {tr(
                "Du är lyssnare i detta rum. Hosten styr källa och uppspelning.",
                "You are a listener in this room. The host controls source and playback."
              )}
            </p>
          )}
        </article>
      ) : null}

      <article className="profile-field silentDiscoSourcePanel">
        <label>{tr("Välj ljudkälla", "Choose audio source")}</label>

        <div className="silentDiscoKindRow" role="tablist" aria-label={tr("Källtyp", "Source type")}>
          {([
            ["stream", tr("Output stream URL", "Output stream URL")],
            ["upload", tr("Ladda upp fil", "Upload file")],
            ["spotify", "Spotify"],
            ["soundcloud", "SoundCloud"],
          ] as Array<[SilentDiscoSourceKind, string]>).map(([kind, label]) => (
            <button
              key={`source-kind-${kind}`}
              type="button"
              className={linkKind === kind ? "btn-primary" : "btn-ghost"}
              onClick={() => setLinkKind(kind)}
              disabled={!isHost || !room}
            >
              {label}
            </button>
          ))}
        </div>

        {linkKind === "upload" ? (
          <div className="silentDiscoUploadRow">
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp3,.wav,.flac,.ogg,.aac,.m4a,audio/mpeg,audio/wav,audio/flac,audio/ogg,audio/aac,audio/mp4"
              onChange={onUploadPicked}
              disabled={!isHost || !room || uploadBusy}
            />
            <p className="help-text">
              {tr(
                `Stöd: MP3, WAV, FLAC, OGG, AAC, M4A. Max ${MAX_UPLOAD_SIZE_MB} MB.`,
                `Supported: MP3, WAV, FLAC, OGG, AAC, M4A. Max ${MAX_UPLOAD_SIZE_MB} MB.`
              )}
            </p>
          </div>
        ) : (
          <>
            <input
              type="text"
              placeholder={tr("Titel (valfritt)", "Title (optional)")}
              value={streamTitle}
              onChange={(e) => setStreamTitle(e.target.value)}
              disabled={!isHost || !room}
            />
            <input
              type="url"
              placeholder={
                linkKind === "stream"
                  ? tr("https://... direkt audio/stream URL", "https://... direct audio/stream URL")
                  : linkKind === "spotify"
                    ? "https://open.spotify.com/..."
                    : "https://soundcloud.com/..."
              }
              value={streamUrl}
              onChange={(e) => setStreamUrl(e.target.value)}
              disabled={!isHost || !room}
            />
            <button className="btn-primary" type="button" onClick={setLinkSource} disabled={!isHost || !room}>
              {tr("Sätt som källa", "Set as source")}
            </button>
            {(linkKind === "spotify" || linkKind === "soundcloud") ? (
              <p className="help-text">
                {tr(
                  "Spotify/SoundCloud-länkar kan delas i rummet, men exakt synk och uppspelning direkt i spelaren kräver uppladdad fil eller direkt stream-URL.",
                  "Spotify/SoundCloud links can be shared in the room, but exact sync and in-player playback require an uploaded file or direct stream URL."
                )}
              </p>
            ) : null}
          </>
        )}
      </article>

      {status ? <p className="status">{status}</p> : null}
      {error ? <p className="status bad">{error}</p> : null}

      {currentSource && (currentSource.kind === "spotify" || currentSource.kind === "soundcloud") ? (
        <p className="summary-detail">
          {tr("Extern källa:", "External source:")} {" "}
          <a className="btn-link" href={currentSource.url} target="_blank" rel="noreferrer">
            {currentSource.title}
          </a>
        </p>
      ) : null}

      <p className="summary-detail">
        {tr(
          "Tips: Om du vill ha perfekt synk från Spotify/SoundCloud, mata in en separat output-stream URL (t.ex. Icecast/HLS) under 'Output stream URL'.",
          "Tip: For perfect sync from Spotify/SoundCloud, provide a separate output stream URL (for example Icecast/HLS) under 'Output stream URL'."
        )}
      </p>
    </section>
  );
}
