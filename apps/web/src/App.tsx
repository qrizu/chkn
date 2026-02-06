import { useEffect, useMemo, useRef, useState } from "react";
import Flatpickr from "react-flatpickr";
import "flatpickr/dist/flatpickr.css";
import { Swedish } from "flatpickr/dist/l10n/sv.js";
import { MapContainer, Marker, TileLayer, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { socket } from "./socket";

type ServerEvent = { type: string; payload: any };
type ProfilePayload = {
  user_id: string;
  birth_date: string;
  birth_time: string | null;
  unknown_time: boolean;
  birth_place: string;
  birth_lat: number | null;
  birth_lng: number | null;
  tz_name?: string | null;
  tz_offset_minutes?: number | null;
  username?: string | null;
  email?: string | null;
};

type UserInfo = {
  username?: string | null;
  email?: string | null;
  name?: string | null;
};

type ProfileInsights = {
  insight_id: string;
  summary_json: {
    chinese_zodiac: string;
    astrology: { sun: string | null; moon: string | null; ascendant: string | null };
    human_design: {
      type: string | null;
      profile: string | null;
      authority: string | null;
      strategy: string | null;
      role: string | null;
    };
    meta: { assumed_time: string | null; timezone: string | null; tz_offset_minutes: number };
  };
  astrology_json: any;
  human_design_json: any;
  created_at: string;
};

type PlaceResult = {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
};

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

type MapClickProps = {
  onPick: (lat: number, lng: number) => void;
};

const MapClickHandler = ({ onPick }: MapClickProps) => {
  useMapEvents({
    click: (event) => {
      onPick(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
};

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
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileMissing, setProfileMissing] = useState(true);
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileInfo, setProfileInfo] = useState<ProfilePayload | null>(null);
  const [insights, setInsights] = useState<ProfileInsights | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(true);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [modal, setModal] = useState<{
    title: string;
    subtitle?: string;
    body: string;
    actions?: { label: string; href: string }[];
  } | null>(null);
  const [mapLatLng, setMapLatLng] = useState<{ lat: number; lng: number } | null>(null);
  const [placeResults, setPlaceResults] = useState<PlaceResult[]>([]);
  const [placeLoading, setPlaceLoading] = useState(false);
  const [showCoords, setShowCoords] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [profileForm, setProfileForm] = useState({
    birthDate: "",
    birthTime: "",
    unknownTime: false,
    birthPlace: "",
    birthLat: "",
    birthLng: "",
  });
  const lastSavedRef = useRef<string>("");
  const draftKey = "chkn.profileDraft";
  const isProfilePage = window.location.pathname.startsWith("/profile");
  const isSettingsPage =
    window.location.pathname.startsWith("/settings") ||
    window.location.pathname.startsWith("/background");
  const [showEditForm, setShowEditForm] = useState(false);
  const houseRows = useMemo(() => {
    const houses = insights?.astrology_json?.houses;
    const cusps = Array.isArray(houses?.cusps) ? houses.cusps : [];
    const planets = Array.isArray(insights?.astrology_json?.planets) ? insights.astrology_json.planets : [];
    const signNames = [
      "Aries",
      "Taurus",
      "Gemini",
      "Cancer",
      "Leo",
      "Virgo",
      "Libra",
      "Scorpio",
      "Sagittarius",
      "Capricorn",
      "Aquarius",
      "Pisces",
    ];
    const signSymbols: Record<string, string> = {
      Aries: "♈",
      Taurus: "♉",
      Gemini: "♊",
      Cancer: "♋",
      Leo: "♌",
      Virgo: "♍",
      Libra: "♎",
      Scorpio: "♏",
      Sagittarius: "♐",
      Capricorn: "♑",
      Aquarius: "♒",
      Pisces: "♓",
    };
    const houseSign = (idx: number) => {
      const lon = cusps[idx - 1];
      if (typeof lon !== "number") return "–";
      const signIdx = Math.floor((((lon % 360) + 360) % 360) / 30);
      return signNames[signIdx] ?? "–";
    };
    const planetsByHouse = new Map<number, { name: string; symbol: string; sign?: string }[]>();
    const planetSymbols: Record<string, string> = {
      Sun: "☉",
      Moon: "☾",
      Mercury: "☿",
      Venus: "♀",
      Mars: "♂",
      Jupiter: "♃",
      Saturn: "♄",
      Uranus: "♅",
      Neptune: "♆",
      Pluto: "♇",
      "North Node": "☊",
      Lilith: "⚸",
      Chiron: "⚷",
    };
    planets.forEach((p: any) => {
      const h = typeof p.house === "number" ? p.house : null;
      if (!h) return;
      const list = planetsByHouse.get(h) ?? [];
      list.push({ name: p.name, symbol: planetSymbols[p.name] ?? "•", sign: p.sign });
      planetsByHouse.set(h, list);
    });
    const ascSign = (() => {
      const ascLon = insights?.astrology_json?.houses?.asc;
      if (typeof ascLon !== "number") return null;
      const signIdx = Math.floor((((ascLon % 360) + 360) % 360) / 30);
      return signNames[signIdx] ?? null;
    })();
    return Array.from({ length: 12 }, (_, i) => {
      const house = i + 1;
      const planets = planetsByHouse.get(house) ?? [];
      const ascendant = house === 1 && ascSign ? "Ascendant" : null;
      const showSign = planets.length > 0 || !!ascendant;
      return {
        house,
        sign: showSign ? houseSign(house) : "",
        signSymbol: showSign ? signSymbols[houseSign(house)] ?? "" : "",
        planets,
        ascendant,
        show: showSign,
      };
    }).filter((row) => row.show);
  }, [insights]);

  const signSymbolFor = (sign?: string | null) => {
    if (!sign) return "";
    const map: Record<string, string> = {
      Aries: "♈",
      Taurus: "♉",
      Gemini: "♊",
      Cancer: "♋",
      Leo: "♌",
      Virgo: "♍",
      Libra: "♎",
      Scorpio: "♏",
      Sagittarius: "♐",
      Capricorn: "♑",
      Aquarius: "♒",
      Pisces: "♓",
    };
    return map[sign] ?? "";
  };

  const planetByName = useMemo(() => {
    const planets = Array.isArray(insights?.astrology_json?.planets)
      ? insights!.astrology_json.planets
      : [];
    return new Map<string, any>(planets.map((p: any) => [p.name, p]));
  }, [insights]);

  const ascLon = insights?.astrology_json?.houses?.asc;

  const openModal = (title: string, body: string, subtitle?: string, actions?: { label: string; href: string }[]) => {
    setModal({ title, body, subtitle, actions });
  };

  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  const planetMeaning: Record<string, string> = {
    Sun: "The Sun determines your ego, identity, and role in life. It’s the core of who you are.",
    Moon: "The Moon rules your emotions, moods, and inner needs.",
    Mercury: "Mercury governs how you think, communicate, and learn.",
    Venus: "Venus rules how you love, what you value, and what attracts you.",
    Mars: "Mars is how you assert yourself, act, and pursue what you want.",
    Jupiter: "Jupiter is growth, optimism, and meaning.",
    Saturn: "Saturn is responsibility, boundaries, and long‑term lessons.",
    Uranus: "Uranus is change, freedom, and originality.",
    Neptune: "Neptune is imagination, intuition, and ideals.",
    Pluto: "Pluto is power, transformation, and deep change.",
    "North Node": "The North Node is your growth direction and life theme.",
    Lilith: "Lilith is your raw, untamed self-expression.",
    Chiron: "Chiron is your wound and the path to healing.",
  };

  const signMeaning: Record<string, string> = {
    Aries: "Aries is bold, direct, and pioneering.",
    Taurus: "Taurus is steady, grounded, and loyal.",
    Gemini: "Gemini is curious, quick, and communicative.",
    Cancer: "Cancer is caring, sensitive, and protective.",
    Leo: "Leo is warm, expressive, and proud.",
    Virgo: "Virgo is precise, analytical, and improvement‑focused.",
    Libra: "Libra is balanced, relational, and fair‑minded.",
    Scorpio: "Scorpio is intense, deep, and transformative.",
    Sagittarius: "Sagittarius is adventurous, optimistic, and freedom‑seeking.",
    Capricorn: "Capricorn is disciplined, ambitious, and responsible.",
    Aquarius: "Aquarius is original, visionary, and future‑oriented.",
    Pisces: "Pisces is intuitive, empathetic, and imaginative.",
  };

  const zodiacMeaning: Record<string, string> = {
    Rat: "The Rat is clever, quick, and adaptive. For you, this can show up as fast problem‑solving.",
    Ox: "The Ox is patient, loyal, and steady. For you, it can feel like deep endurance.",
    Tiger: "The Tiger is bold, passionate, and independent. For you, it can feel like strong drive.",
    Rabbit: "The Rabbit is sensitive, diplomatic, and gentle. For you, it can show as calm balance.",
    Dragon: "The Dragon is powerful, magnetic, and visionary. For you, it can show as strong presence.",
    Snake: "The Snake is intuitive, deep, and strategic. For you, it can feel like sharp insight.",
    Horse: "The Horse is free, energetic, and moving forward. For you, it can feel like momentum.",
    Goat: "The Goat is creative, empathetic, and harmonious. For you, it can feel like soft strength.",
    Monkey: "The Monkey is playful, smart, and curious. For you, it can feel like creative agility.",
    Rooster: "The Rooster is precise, proud, and clear. For you, it can show as focus and structure.",
    Dog: "The Dog is loyal, fair, and protective. For you, it can feel like dependable support.",
    Pig: "The Pig is warm, generous, and grounded. For you, it can feel like heart‑led presence.",
  };

  const zodiacMeta: Record<
    string,
    { animalChar: string; earthlyBranch: string; yinYang: string; trine: string; element: string }
  > = {
    Rat: { animalChar: "鼠 shǔ", earthlyBranch: "子 zǐ", yinYang: "Yang", trine: "1st", element: "Water" },
    Ox: { animalChar: "牛 niú", earthlyBranch: "丑 chǒu", yinYang: "Yin", trine: "2nd", element: "Earth" },
    Tiger: { animalChar: "虎 hǔ", earthlyBranch: "寅 yín", yinYang: "Yang", trine: "3rd", element: "Wood" },
    Rabbit: { animalChar: "兔 tù", earthlyBranch: "卯 mǎo", yinYang: "Yin", trine: "4th", element: "Wood" },
    Dragon: { animalChar: "龙 lóng", earthlyBranch: "辰 chén", yinYang: "Yang", trine: "1st", element: "Earth" },
    Snake: { animalChar: "蛇 shé", earthlyBranch: "巳 sì", yinYang: "Yin", trine: "2nd", element: "Fire" },
    Horse: { animalChar: "马 mǎ", earthlyBranch: "午 wǔ", yinYang: "Yang", trine: "3rd", element: "Fire" },
    Goat: { animalChar: "羊 yáng", earthlyBranch: "未 wèi", yinYang: "Yin", trine: "4th", element: "Earth" },
    Monkey: { animalChar: "猴 hóu", earthlyBranch: "申 shēn", yinYang: "Yang", trine: "1st", element: "Metal" },
    Rooster: { animalChar: "鸡 jī", earthlyBranch: "酉 yǒu", yinYang: "Yin", trine: "2nd", element: "Metal" },
    Dog: { animalChar: "狗 gǒu", earthlyBranch: "戌 xū", yinYang: "Yang", trine: "3rd", element: "Earth" },
    Pig: { animalChar: "猪 zhū", earthlyBranch: "亥 hài", yinYang: "Yin", trine: "4th", element: "Water" },
  };

  const zodiacIcons: Record<string, string> = {
    Rat: "🐀",
    Ox: "🐂",
    Tiger: "🐅",
    Rabbit: "🐇",
    Dragon: "🐉",
    Snake: "🐍",
    Horse: "🐎",
    Goat: "🐐",
    Monkey: "🐒",
    Rooster: "🐓",
    Dog: "🐕",
    Pig: "🐖",
  };

  const elementIcons: Record<string, JSX.Element> = {
    Wood: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 4v16M6 10h12M8 6h8M7 18h10" stroke="currentColor" strokeWidth="1.6" fill="none" />
      </svg>
    ),
    Fire: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 3c2 3 1 5-1 7 3-1 6 2 6 5 0 3-2 6-5 6s-5-2-5-5c0-3 2-5 5-7z"
          stroke="currentColor"
          strokeWidth="1.4"
          fill="none"
        />
      </svg>
    ),
    Earth: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 8h14M7 14h10M12 4v16" stroke="currentColor" strokeWidth="1.6" fill="none" />
      </svg>
    ),
    Metal: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6h12v12H6zM6 12h12M12 6v12" stroke="currentColor" strokeWidth="1.4" fill="none" />
      </svg>
    ),
    Water: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 12c2 2 6 2 8 0" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <path d="M6 16c3 2 9 2 12 0" stroke="currentColor" strokeWidth="1.6" fill="none" />
      </svg>
    ),
  };

  const houseMeaning: Record<number, string> = {
    1: "The 1st house is identity, presence, and first impression.",
    2: "The 2nd house is values, security, and resources.",
    3: "The 3rd house is communication, learning, and daily life.",
    4: "The 4th house is home, roots, and inner safety.",
    5: "The 5th house is creativity, love, and play.",
    6: "The 6th house is work, health, and routines.",
    7: "The 7th house is partnerships and close relationships.",
    8: "The 8th house is transformation, intimacy, and depth.",
    9: "The 9th house is meaning, philosophy, and travel.",
    10: "The 10th house is career, status, and ambition.",
    11: "The 11th house is community, friends, and vision.",
    12: "The 12th house is the subconscious and restoration.",
  };

  const houseNames: Record<number, string> = {
    1: "first house",
    2: "second house",
    3: "third house",
    4: "fourth house",
    5: "fifth house",
    6: "sixth house",
    7: "seventh house",
    8: "eighth house",
    9: "ninth house",
    10: "tenth house",
    11: "eleventh house",
    12: "twelfth house",
  };

  const signTone: Record<string, string> = {
    Aries: "acts fast, leads with courage, and prefers directness.",
    Taurus: "moves steadily, values comfort, and builds lasting results.",
    Gemini: "thinks quickly, communicates openly, and thrives on variety.",
    Cancer: "feels deeply, protects what matters, and seeks emotional safety.",
    Leo: "expresses boldly, shines naturally, and leads with heart.",
    Virgo: "analyzes details, improves systems, and values precision.",
    Libra: "seeks balance, connects through relationships, and values fairness.",
    Scorpio: "dives deep, transforms through intensity, and protects what’s private.",
    Sagittarius: "explores freely, learns through experience, and trusts optimism.",
    Capricorn: "builds patiently, commits to goals, and respects structure.",
    Aquarius: "innovates, thinks ahead, and values independence.",
    Pisces: "intuits, empathizes, and blends imagination with feeling.",
  };

  const houseDetail: Record<number, string> = {
    1: "your identity, personal style, and how people read you.",
    2: "money, possessions, self‑worth, and what feels secure.",
    3: "communication, learning style, siblings, and daily movement.",
    4: "home, family, roots, and emotional foundation.",
    5: "creativity, romance, joy, and self‑expression.",
    6: "work habits, health, service, and daily routines.",
    7: "partnerships, intimacy, and how you do commitment.",
    8: "transformation, vulnerability, shared resources, and rebirth.",
    9: "beliefs, education, travel, and big‑picture meaning.",
    10: "career, reputation, and long‑term ambition.",
    11: "community, friendships, and future vision.",
    12: "subconscious patterns, solitude, and spiritual renewal.",
  };

  const describeSign = (sign?: string | null) => {
    if (!sign) return "The sign shows how the energy expresses itself.";
    return signMeaning[sign] ?? "The sign shows how the energy expresses itself.";
  };

  const describeSignDeep = (sign?: string | null) => {
    if (!sign) return "The sign shows how the energy expresses itself.";
    const tone = signTone[sign] ?? "expresses in its own unique way.";
    return `${signMeaning[sign] ?? "The sign shows how the energy expresses itself."} It often ${tone}`;
  };

  const describePlanet = (planetName: string, sign?: string | null, house?: number | null) => {
    const planetText = planetMeaning[planetName] ?? "This planet describes a life theme.";
    const signText = describeSign(sign);
    const houseText = house ? houseMeaning[house] ?? "" : "";
    const houseSuffix = house ? ` It lands in the ${houseNames[house] ?? `house ${house}`}.` : "";
    return `${planetText} ${signText}${houseSuffix} ${houseText} For you, this is a place where the theme becomes personal and visible.`.trim();
  };

  const describePlanetDeep = (planetName: string, sign?: string | null, house?: number | null) => {
    const planetText = planetMeaning[planetName] ?? "This planet describes a life theme.";
    const signText = describeSignDeep(sign);
    const houseText = house ? houseMeaning[house] ?? "" : "";
    const houseFocus = house ? houseDetail[house] ?? "a key life area." : "a key life area.";
    const houseSuffix = house ? ` It lands in the ${houseNames[house] ?? `house ${house}`}, which rules ${houseFocus}` : "";
    return `${planetText} ${signText}${houseSuffix} ${houseText} For you, this shows where the energy is strongest and how you naturally express it.`.trim();
  };

  const describeAscendant = (sign?: string | null) => {
    const signText = describeSign(sign);
    return `The Ascendant is the “mask” you present to people and your first impression. ${signText} For you, it colors how others read you at a glance.`;
  };

  const describeAscendantDeep = (sign?: string | null) => {
    const signText = describeSignDeep(sign);
    return `The Ascendant is the “mask” you present to people and your first impression. ${signText} It shapes your style, presence, and the energy you project when you enter a room.`;
  };

  const ordinalHouse = (house?: number | null) => {
    if (!house) return "";
    if (house === 1) return "1st House";
    if (house === 2) return "2nd House";
    if (house === 3) return "3rd House";
    return `${house}th House`;
  };

  const planetSubtitle = (planetName: string) => {
    const p = planetByName.get(planetName);
    if (!p) return undefined;
    const deg = formatDegree(p.lon);
    const houseLabel = ordinalHouse(p.house);
    return `${p.sign ?? "–"}, ${deg} · ${houseLabel}`;
  };

  const formatDegree = (lon?: number | null) => {
    if (typeof lon !== "number") return "";
    const deg = ((lon % 360) + 360) % 360;
    const within = deg % 30;
    const d = Math.floor(within);
    const mFloat = (within - d) * 60;
    const m = Math.floor(mFloat);
    const s = Math.round((mFloat - m) * 60);
    const pad = (v: number) => String(v).padStart(2, "0");
    return `${d}°${pad(m)}'${pad(s)}"`;
  };

  const profileUrl = useMemo(() => {
    const base = (import.meta.env.VITE_API_URL || "").trim();
    if (!base) return `${window.location.origin}/api/profile`;
    const clean = base.replace(/\/$/, "");
    return clean.endsWith("/api") ? `${clean}/profile` : `${clean}/api/profile`;
  }, []);
  const placesUrl = useMemo(() => {
    const base = (import.meta.env.VITE_API_URL || "").trim();
    if (!base) return `${window.location.origin}/api/places`;
    const clean = base.replace(/\/$/, "");
    return clean.endsWith("/api") ? `${clean}/places` : `${clean}/api/places`;
  }, []);
  const insightsUrl = useMemo(() => {
    const base = (import.meta.env.VITE_API_URL || "").trim();
    if (!base) return `${window.location.origin}/api/profile/insights`;
    const clean = base.replace(/\/$/, "");
    return clean.endsWith("/api") ? `${clean}/profile/insights` : `${clean}/api/profile/insights`;
  }, []);
  const insightsCalcUrl = useMemo(() => {
    const base = (import.meta.env.VITE_API_URL || "").trim();
    if (!base) return `${window.location.origin}/api/profile/insights/calc`;
    const clean = base.replace(/\/$/, "");
    return clean.endsWith("/api") ? `${clean}/profile/insights/calc` : `${clean}/api/profile/insights/calc`;
  }, []);
  const authBaseUrl = useMemo(() => {
    const base = (import.meta.env.VITE_AUTHENTIK_URL || "https://auth.sputnet.space").trim();
    return base.replace(/\/$/, "");
  }, []);
  const dateLocale = useMemo(() => {
    return (navigator.language || "sv-SE").trim();
  }, []);
  const defaultBirthDate = useMemo(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 26);
    return d;
  }, []);
  const formatUtcOffset = (minutes?: number | null) => {
    if (minutes === null || minutes === undefined) return "—";
    const sign = minutes >= 0 ? "+" : "-";
    const abs = Math.abs(minutes);
    const hours = Math.floor(abs / 60);
    const mins = abs % 60;
    return `${sign}${hours}${mins ? `:${String(mins).padStart(2, "0")}` : ""}`;
  };

  const getTzOffsetMinutes = (timeZone: string | null, dateStr: string, timeStr: string) => {
    if (!timeZone) return null;
    const [y, m, d] = dateStr.split("-").map((v) => Number(v));
    if (!y || !m || !d) return null;
    const [hh, mm, ss] = (timeStr || "12:00:00").split(":").map((v) => Number(v));
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = fmt.formatToParts(new Date(Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0)));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const inputUtc = Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0);
    return Math.round((asUtc - inputUtc) / 60000);
  };

  useEffect(() => {
    const loadProfile = async () => {
      try {
        const res = await fetch(profileUrl, { credentials: "include" });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
          if (res.status === 401) {
            setProfileMissing(true);
          } else {
            setProfileError(data?.error || "Kunde inte läsa profil.");
            setProfileMissing(true);
          }
        } else if (data.profile) {
          const p = data.profile as ProfilePayload;
          const nextForm = {
            birthDate: p.birth_date ?? "",
            birthTime: p.birth_time ?? "",
            unknownTime: !!p.unknown_time,
            birthPlace: p.birth_place ?? "",
            birthLat: p.birth_lat?.toString() ?? "",
            birthLng: p.birth_lng?.toString() ?? "",
          };
          setProfileForm(nextForm);
          lastSavedRef.current = JSON.stringify(nextForm);
          setProfileDirty(false);
          if (typeof p.birth_lat === "number" && typeof p.birth_lng === "number") {
            setMapLatLng({ lat: p.birth_lat, lng: p.birth_lng });
          }
          setProfileMissing(false);
          setProfileInfo(p);
          if (data.user) {
            setProfileInfo((prev) => ({ ...(prev ?? p), ...(data.user as UserInfo) }));
          }
          try {
            const draftRaw = localStorage.getItem(draftKey);
            if (draftRaw) {
              const draft = JSON.parse(draftRaw);
              if (draft?.form) {
                setProfileForm(draft.form);
                setProfileDirty(true);
              }
            }
          } catch {
            // ignore draft errors
          }
        } else {
          setProfileMissing(true);
          if (data.user) {
            setProfileInfo((prev) => ({ ...(prev ?? ({ user_id: "" } as ProfilePayload)), ...(data.user as UserInfo) }));
          } else {
            setProfileInfo(null);
          }
        }
      } catch (err) {
        setProfileError("Kunde inte läsa profil.");
      } finally {
        setProfileLoading(false);
      }
    };
    loadProfile();
  }, [profileUrl]);

  useEffect(() => {
    const loadInsights = async () => {
      try {
        const res = await fetch(insightsUrl, { credentials: "include" });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.ok && data.insights) {
          setInsights(data.insights as ProfileInsights);
        } else if (!res.ok && res.status !== 401) {
          setInsightsError(data?.error || "Kunde inte läsa profiler.");
        }
      } catch {
        setInsightsError("Kunde inte läsa profiler.");
      } finally {
        setInsightsLoading(false);
      }
    };
    loadInsights();
  }, [insightsUrl]);

  useEffect(() => {
    const query = profileForm.birthPlace.trim();
    if (query.length < 2) {
      setPlaceResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      setPlaceLoading(true);
      try {
        const res = await fetch(`${placesUrl}?q=${encodeURIComponent(query)}`);
        const data = await res.json().catch(() => null);
        if (res.ok && data?.ok && Array.isArray(data.results)) {
          setPlaceResults(data.results);
        } else {
          setPlaceResults([]);
        }
      } catch {
        setPlaceResults([]);
      } finally {
        setPlaceLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [profileForm.birthPlace, placesUrl]);

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

  const handleProfileChange = (key: keyof typeof profileForm, value: string | boolean) => {
    setProfileForm((prev) => {
      const next = { ...prev, [key]: value };
      const snap = JSON.stringify(next);
      setProfileDirty(snap !== lastSavedRef.current);
      try {
        localStorage.setItem(draftKey, JSON.stringify({ form: next, ts: Date.now() }));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const handleBirthDateChange = (dates: Date[]) => {
    const date = dates?.[0];
    if (!date) return;
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    handleProfileChange("birthDate", `${yyyy}-${mm}-${dd}`);
  };

  const handleMapPick = (lat: number, lng: number) => {
    setMapLatLng({ lat, lng });
    handleProfileChange("birthLat", lat.toFixed(5));
    handleProfileChange("birthLng", lng.toFixed(5));
    if (!profileForm.birthPlace) {
      handleProfileChange("birthPlace", `Lat ${lat.toFixed(2)}, Lng ${lng.toFixed(2)}`);
    }
  };

  const handlePlaceSelect = (place: PlaceResult) => {
    handleProfileChange("birthPlace", place.name);
    if (place.lat !== null) handleProfileChange("birthLat", place.lat.toFixed(5));
    if (place.lng !== null) handleProfileChange("birthLng", place.lng.toFixed(5));
    if (place.lat !== null && place.lng !== null) {
      setMapLatLng({ lat: place.lat, lng: place.lng });
    }
    setPlaceResults([]);
  };

  const useDeviceLocation = () => {
    if (!navigator.geolocation) {
      setProfileStatus("Geolokalisering stöds inte i denna webbläsare.");
      return;
    }
    setProfileStatus("Hämtar plats...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        handleProfileChange("birthLat", lat.toFixed(5));
        handleProfileChange("birthLng", lng.toFixed(5));
        setMapLatLng({ lat, lng });
        if (!profileForm.birthPlace) {
          handleProfileChange("birthPlace", `Lat ${lat.toFixed(2)}, Lng ${lng.toFixed(2)}`);
        }
        setProfileStatus("Plats hämtad.");
      },
      () => {
        setProfileStatus("Kunde inte hämta plats.");
      },
      { enableHighAccuracy: false, timeout: 8000 }
    );
  };

  const saveProfile = async () => {
    if (!profileForm.birthDate || !profileForm.birthPlace.trim()) {
      setProfileError("Fyll i födelsedatum och födelseplats först.");
      return;
    }
      setProfileStatus("Saving...");
    setProfileError(null);
    const unknownTime = profileForm.unknownTime || !profileForm.birthTime;
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    const tzOffsetMinutes = getTzOffsetMinutes(
      tzName,
      profileForm.birthDate,
      unknownTime ? "12:00:00" : profileForm.birthTime || "12:00:00"
    );
    const payload = {
      birthDate: profileForm.birthDate,
      birthTime: unknownTime ? "" : profileForm.birthTime,
      unknownTime,
      birthPlace: profileForm.birthPlace,
      birthLat: profileForm.birthLat ? Number(profileForm.birthLat) : null,
      birthLng: profileForm.birthLng ? Number(profileForm.birthLng) : null,
      tzName,
      tzOffsetMinutes,
    };
    try {
      const res = await fetch(profileUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setProfileError(data?.error || "Could not save.");
        setProfileStatus(null);
        return;
      }
      if (data?.profile) {
        setProfileInfo(data.profile as ProfilePayload);
      }
      setProfileStatus("Saved. Calculating profile...");
      lastSavedRef.current = JSON.stringify(profileForm);
      setProfileDirty(false);
      try {
        localStorage.removeItem(draftKey);
      } catch {
        // ignore storage errors
      }
      try {
        const calcRes = await fetch(insightsCalcUrl, {
          method: "POST",
          credentials: "include",
        });
        const calcData = await calcRes.json().catch(() => null);
        if (!calcRes.ok || !calcData?.ok) {
          setProfileStatus("Saved, but calculation failed.");
        } else {
          setProfileStatus("Saved and calculated.");
          if (calcData.insights) setInsights(calcData.insights as ProfileInsights);
        }
      } catch {
        setProfileStatus("Saved, but calculation failed.");
      }
      try {
        const refreshed = await fetch(profileUrl, { credentials: "include" });
        const refreshedData = await refreshed.json().catch(() => null);
        if (refreshed.ok && refreshedData?.ok && refreshedData.profile) {
          setProfileInfo(refreshedData.profile as ProfilePayload);
        }
      } catch {
        // ignore refresh failures
      }
      setProfileMissing(false);
      setShowEditForm(false);
    } catch (err) {
      setProfileError("Could not save.");
      setProfileStatus(null);
    }
  };

  return (
    <main className="app">
      <nav className="top-nav">
        <div className="brand">CHKN</div>
        <div className="nav-links">
          <a className={isProfilePage || isSettingsPage ? "nav-link" : "nav-link active"} href="/">
            Lobby
          </a>
          <a className={isProfilePage ? "nav-link active" : "nav-link"} href="/profile">
            Profil
          </a>
          <a className={isSettingsPage ? "nav-link active" : "nav-link"} href="/settings">
            Settings
          </a>
        </div>
      </nav>

      {isProfilePage ? (
        <>
          {modal ? (
            <div
              className="modal-backdrop"
              role="dialog"
              aria-modal="true"
              onClick={() => setModal(null)}
            >
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <div>
                    <h3>{modal.title}</h3>
                    {modal.subtitle ? <p className="modal-subtitle">{modal.subtitle}</p> : null}
                  </div>
                  <button
                    className="modal-close"
                    onClick={() => setModal(null)}
                    aria-label="Stäng"
                    title="Stäng"
                  >
                    ×
                  </button>
                </div>
                <div className="modal-body">
                  <p>{modal.body}</p>
                  {modal.actions?.length ? (
                    <div className="modal-actions">
                      {modal.actions.map((action) => (
                        <a
                          key={action.href}
                          className="btn-ghost"
                          href={action.href}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {action.label}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
          {profileMissing ? (
            <section className="profile-card">
        <div className="profile-header">
          <div>
            <p className="eyebrow">Profile</p>
            <h2>Create your astro profile</h2>
            <p className="lead">
              We use birth data to build your profile. You can leave time unknown.
            </p>
        </div>
        <div className="profile-badge">
            <span>{profileLoading ? "Loading…" : profileMissing ? "Missing" : profileDirty ? "Changes" : "Ready"}</span>
        </div>
        </div>

        <div className="profile-grid">
          <div className="profile-field">
            <label>Date of birth</label>
            <Flatpickr
              className="flatpickr-input"
              options={{
                dateFormat: "Y-m-d",
                ...(dateLocale.startsWith("sv") ? { locale: Swedish } : {}),
                defaultDate: profileForm.birthDate || defaultBirthDate,
              }}
              onChange={handleBirthDateChange}
              value={profileForm.birthDate}
            />
            <p className="help-text">Format: YYYY-MM-DD</p>
          </div>
          <div className="profile-field">
            <label>Time of birth</label>
            <input
              type="time"
              value={profileForm.birthTime}
              onChange={(e) => handleProfileChange("birthTime", e.target.value)}
              disabled={profileForm.unknownTime}
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={profileForm.unknownTime}
                onChange={(e) => handleProfileChange("unknownTime", e.target.checked)}
              />
              Unknown time
            </label>
          </div>
          <div className="profile-field">
            <label>City of birth</label>
            <div className="autocomplete">
              <input
                type="text"
                placeholder="City, country"
                value={profileForm.birthPlace}
                onChange={(e) => handleProfileChange("birthPlace", e.target.value)}
              />
              {placeLoading ? <div className="autocomplete-status">Searching…</div> : null}
              {placeResults.length ? (
                <ul className="autocomplete-list">
                  {placeResults.map((place) => (
                    <li key={place.id}>
                      <button type="button" onClick={() => handlePlaceSelect(place)}>
                        {place.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="toggle-row">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={showCoords}
                  onChange={(e) => setShowCoords(e.target.checked)}
                />
                Enter coordinates
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={showMap}
                  onChange={(e) => setShowMap(e.target.checked)}
                />
                Pick on map
              </label>
            </div>
          </div>
          {showCoords ? (
            <div className="profile-field">
              <label>Coordinates</label>
              <div className="coord-row">
                <input
                  type="text"
                  placeholder="Lat"
                  value={profileForm.birthLat}
                  onChange={(e) => handleProfileChange("birthLat", e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Lng"
                  value={profileForm.birthLng}
                  onChange={(e) => handleProfileChange("birthLng", e.target.value)}
                />
              </div>
              <button className="btn-ghost" type="button" onClick={useDeviceLocation}>
                Use my location
              </button>
            </div>
          ) : null}
        </div>

        {showMap ? (
          <div className="map-panel">
            <div className="map-header">
              <h3>Pick a location</h3>
              <p>Click to set an approximate coordinate.</p>
            </div>
            <div className="map-canvas" role="button" tabIndex={0}>
              <MapContainer
                center={mapLatLng ?? { lat: 59.3293, lng: 18.0686 }}
                zoom={mapLatLng ? 10 : 4}
                scrollWheelZoom={false}
                className="map-leaflet"
              >
                <TileLayer
                  attribution="&copy; OpenStreetMap contributors"
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <MapClickHandler onPick={handleMapPick} />
                {mapLatLng ? <Marker position={mapLatLng} /> : null}
              </MapContainer>
            </div>
          </div>
        ) : null}

        <div className="profile-actions">
          <button className="btn-primary" onClick={saveProfile} disabled={profileLoading}>
            Save profile
          </button>
          {profileStatus ? <span className="status">{profileStatus}</span> : null}
          {profileError ? <span className="status bad">{profileError}</span> : null}
        </div>
      </section>
          ) : null}

          {!profileMissing ? (
          <section className="profile-card profile-insights">
            <p className="eyebrow">Your profile</p>

          <div className="summary-row">
          <button
            type="button"
            className="summary-card account-card"
            onClick={() =>
              openModal(
                "Account",
                "Your username and email are managed in Authentik. You can view or update security settings there.",
                undefined,
                [{ label: "Open account page", href: `${authBaseUrl}/if/user/` }]
              )
            }
          >
            <h3>Account</h3>
            <div className="summary-items">
              <div className="summary-item">
                <span className="summary-icon">👤</span>
                <div>
                  <p className="summary-label">Username</p>
                  <p className="summary-value">{profileInfo?.username ?? "—"}</p>
                </div>
              </div>
              <div className="summary-item">
                <span className="summary-icon">✉</span>
                <div>
                  <p className="summary-label">Email</p>
                  <p className="summary-value">{profileInfo?.email ?? "—"}</p>
                </div>
              </div>
            </div>
          </button>
          <div className="summary-card">
            <h3>Astro</h3>
            <div className="summary-items">
              <button
                type="button"
                className="summary-item"
                onClick={() =>
                  openModal(
                    "Sun",
                    `${describePlanetDeep(
                      "Sun",
                      insights?.summary_json?.astrology?.sun ?? null,
                      null
                    )} Your Sun sign describes how you shine and lead in life, and what energizes you at your core.`,
                    insights?.summary_json?.astrology?.sun ?? undefined
                  )
                }
              >
                <span className="summary-icon">☉</span>
                <div>
                  <p className="summary-label">Sun</p>
                  <p className="summary-value">
                    <span className="summary-sign">{signSymbolFor(insights?.summary_json?.astrology?.sun ?? null)}</span>
                    {insights?.summary_json?.astrology?.sun ?? "–"}
                  </p>
                </div>
              </button>
              <button
                type="button"
                className="summary-item"
                onClick={() =>
                  openModal(
                    "Moon",
                    `${describePlanetDeep(
                      "Moon",
                      insights?.summary_json?.astrology?.moon ?? null,
                      null
                    )} Your Moon sign shows how you process feelings and what makes you feel safe.`,
                    insights?.summary_json?.astrology?.moon ?? undefined
                  )
                }
              >
                <span className="summary-icon">☾</span>
                <div>
                  <p className="summary-label">Moon</p>
                  <p className="summary-value">
                    <span className="summary-sign">{signSymbolFor(insights?.summary_json?.astrology?.moon ?? null)}</span>
                    {insights?.summary_json?.astrology?.moon ?? "–"}
                  </p>
                </div>
              </button>
              <button
                type="button"
                className="summary-item"
                onClick={() =>
                  openModal(
                    "Ascendant",
                    `${describeAscendantDeep(insights?.summary_json?.astrology?.ascendant ?? null)} It often colors your style and the immediate vibe you give off.`,
                    insights?.summary_json?.astrology?.ascendant ?? undefined
                  )
                }
              >
                <span className="summary-icon">↥</span>
                <div>
                  <p className="summary-label">Ascendant</p>
                  <p className="summary-value">
                    <span className="summary-sign">{signSymbolFor(insights?.summary_json?.astrology?.ascendant ?? null)}</span>
                    {insights?.summary_json?.astrology?.ascendant ?? "–"}
                  </p>
                </div>
              </button>
            </div>
          </div>

          <div className="summary-card">
            <h3>Human Design</h3>
            <div className="summary-items">
              <button
                type="button"
                className="summary-item"
                onClick={() =>
                  openModal(
                    "Energy Type",
                    `${(
                      insights?.human_design_json?.type?.description ||
                      "Energy type describes your overall life force and how you best interact with the world."
                    )} For you, this is your baseline way of operating and how others feel your energy.`
                  )
                }
              >
                <span className="summary-icon">⚡</span>
                <div>
                  <p className="summary-label">Energy Type</p>
                  <p className="summary-value">{insights?.summary_json?.human_design?.type ?? "–"}</p>
                </div>
              </button>
              <button
                type="button"
                className="summary-item"
                onClick={() =>
                  openModal(
                    "Strategy",
                    `${(
                      insights?.human_design_json?.type?.strategy ||
                      insights?.summary_json?.human_design?.strategy ||
                      "Strategy is your practical path for decisions and less resistance."
                    )} It’s the path that reduces friction and helps you align your actions.`
                  )
                }
              >
                <span className="summary-icon">↳</span>
                <div>
                  <p className="summary-label">Strategy</p>
                  <p className="summary-value">
                    {insights?.summary_json?.human_design?.strategy ?? "–"}
                  </p>
                </div>
              </button>
              <button
                type="button"
                className="summary-item"
                onClick={() =>
                  openModal(
                    "Authority",
                    `${(
                      insights?.human_design_json?.authority?.description ||
                      "Authority shows where your most reliable inner compass lives."
                    )} It’s your most trusted decision‑making center over time.`
                  )
                }
              >
                <span className="summary-icon">◎</span>
                <div>
                  <p className="summary-label">Authority</p>
                  <p className="summary-value">
                    {insights?.summary_json?.human_design?.authority ?? "–"}
                  </p>
                </div>
              </button>
            </div>
          </div>

          <div className="summary-card zodiac-card">
            <h3>Chinese zodiac</h3>
            <div className="summary-items">
              <div className="zodiac-stack">
                <button
                  type="button"
                  className="summary-item zodiac-row-button"
                  onClick={() =>
                    openModal(
                      "Year animal",
                      `${zodiacMeaning[insights?.summary_json?.chinese_zodiac ?? ""] || "Your year animal is based on your birth year and reflects archetypal traits in Chinese tradition."} ${
                        zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""] ?
                          `\n\nAnimal: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.animalChar}\nEarthly Branch: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.earthlyBranch}\nTrine: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.trine}` :
                          ""
                      }`
                    )
                  }
                >
                  <span className="summary-icon zodiac-icon">
                    {zodiacIcons[insights?.summary_json?.chinese_zodiac ?? ""] ?? "🐉"}
                  </span>
                  <div>
                    <p className="summary-label">Year animal</p>
                    <p className="summary-value">{insights?.summary_json?.chinese_zodiac ?? "–"}</p>
                  </div>
                </button>
                {zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""] ? (
                  <>
                    <button
                      type="button"
                      className="summary-item zodiac-row-button"
                      onClick={() =>
                      openModal(
                        "Yin/Yang",
                        `Yin/Yang describes the polarity of the animal.\n\nYin/Yang: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.yinYang}\nYin tends to be receptive and reflective; Yang tends to be expressive and outward.`
                      )
                    }
                  >
                      <span className="summary-icon zodiac-icon">☯︎</span>
                      <div>
                        <p className="summary-label">Yin/Yang</p>
                        <p className="summary-value">{zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.yinYang}</p>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="summary-item zodiac-row-button"
                      onClick={() =>
                      openModal(
                        "Element",
                        `The fixed element adds a deeper tone to the animal.\n\nElement: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.element}\nThis element colors your strengths, challenges, and how you respond under pressure.`
                      )
                    }
                  >
                      <span className="summary-icon zodiac-icon element-icon">
                        {elementIcons[zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.element] ?? null}
                      </span>
                      <div>
                        <p className="summary-label">Element</p>
                        <p className="summary-value">{zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.element}</p>
                      </div>
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="insights-actions">
          {insightsError ? <span className="status bad">{insightsError}</span> : null}
        </div>
      </section>
          ) : null}

      {!profileMissing ? (
      <section className="profile-card astro-chart">
        <p className="eyebrow">Astrology</p>
        <div className="chart-wrap">
          <div className="house-chart">
            <div className="house-chart-header">
              <span>Signs</span>
              <span className="planet-header">Planets</span>
              <span>House</span>
            </div>
            {houseRows.map((row) => (
              <div key={`house-${row.house}`} className="house-chart-row">
                <div className="house-cell house-cell-sign">
                  <button
                    type="button"
                    className="house-sign"
                    onClick={() =>
                      openModal(
                        `House ${row.house}`,
                        `${houseMeaning[row.house] ?? "This house describes a life area."} Sign: ${row.sign || "–"}. ${describeSignDeep(row.sign)}`
                      )
                    }
                  >
                    <span className="sign-symbol">{row.signSymbol}</span>
                    <span>{row.sign || "–"}</span>
                  </button>
                </div>
                <div className="house-planets">
                  {row.ascendant ? (
                    <button
                      type="button"
                      className="planet-line"
                      onClick={() =>
                        openModal(
                          "Ascendant",
                          describeAscendantDeep(row.sign),
                          ascLon ? `${row.sign ?? "–"}, ${formatDegree(ascLon)} · 1st House` : undefined
                        )
                      }
                    >
                      <span className="planet-symbol">↥</span>
                      <span>{row.ascendant}</span>
                    </button>
                  ) : null}
                  {row.planets.length ? (
                    row.planets.map((p) => (
                      <button
                        key={`${row.house}-${p.name}`}
                        type="button"
                        className="planet-line"
                        onClick={() =>
                          openModal(
                            p.name,
                            describePlanetDeep(p.name, p.sign || row.sign, row.house),
                            planetSubtitle(p.name)
                          )
                        }
                      >
                        <span className="planet-symbol">{p.symbol}</span>
                        <span>{p.name}</span>
                      </button>
                    ))
                  ) : !row.ascendant ? (
                    <span className="planet-empty">–</span>
                  ) : null}
                </div>
                <div className="house-cell house-cell-house">
                  <button
                    type="button"
                    className="house-num"
                    onClick={() =>
                      openModal(
                        `House ${row.house}`,
                        houseMeaning[row.house] ?? "This house describes a life area.",
                        houseNames[row.house] ?? `house ${row.house}`
                      )
                    }
                  >
                  <span className="house-icon" aria-hidden="true">⌂</span>
                  <span className="house-value">{row.house}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="insight-details">
          <div className="detail-grid">
            {(() => {
              const planets = Array.isArray(insights?.astrology_json?.planets)
                ? insights!.astrology_json.planets
                : [];
              const ascLon = insights?.astrology_json?.houses?.asc;
              const ascSign = insights?.summary_json?.astrology?.ascendant ?? null;
              const order = [
                "Sun",
                "Moon",
                "Mercury",
                "Venus",
                "Mars",
                "Jupiter",
                "Saturn",
                "Uranus",
                "Neptune",
                "Pluto",
              ];
              const planetSymbols: Record<string, string> = {
                Sun: "☉",
                Moon: "☾",
                Mercury: "☿",
                Venus: "♀",
                Mars: "♂",
                Jupiter: "♃",
                Saturn: "♄",
                Uranus: "♅",
                Neptune: "♆",
                Pluto: "♇",
              };
              const cards = order
                .map((name) => planets.find((p: any) => p?.name === name))
                .filter(Boolean)
                .map((p: any) => {
                  const deg = formatDegree(p.lon);
                  return (
                    <article key={p.name} className="detail-card">
                      <div className="detail-title">
                        <span className="detail-icon">{planetSymbols[p.name] ?? "•"}</span>
                        <div>
                          <h4>{p.name}</h4>
                          <p>
                            {p.sign}, {deg}
                          </p>
                      <p>House {p.house} · {houseNames[p.house] ?? `house ${p.house}`}</p>
                    </div>
                  </div>
                  <p>{describePlanetDeep(p.name, p.sign, p.house)}</p>
                </article>
              );
            });
            if (typeof ascLon === "number") {
              cards.unshift(
                <article key="Ascendant" className="detail-card">
                  <div className="detail-title">
                    <span className="detail-icon">↥</span>
                    <div>
                      <h4>Ascendant</h4>
                      <p>
                        {ascSign ?? "–"}, {formatDegree(ascLon)}
                      </p>
                    <p>House 1 · 1st House</p>
                    </div>
                  </div>
                  <p>{describeAscendantDeep(ascSign)}</p>
                </article>
              );
            }
              return cards;
            })()}
          </div>
        </div>
      </section>
      ) : null}
        </>
      ) : null}

      {isSettingsPage ? (
        <section className="profile-card background-card">
          <div className="profile-header">
            <div>
              <p className="eyebrow">Settings</p>
              <h2>Profile</h2>
            </div>
            <div className="profile-badge">
              <span>{profileMissing ? "Missing" : "Ready"}</span>
            </div>
          </div>

          <div className="background-grid">
            <article className="background-block">
              <h3>Birth data</h3>
              <p><strong>Date of birth:</strong> {profileInfo?.birth_date ?? "—"}</p>
              <p>
                <strong>Time of birth:</strong>{" "}
                {profileInfo?.birth_time ?? "—"}
                {profileInfo?.tz_name ? ` ${profileInfo.tz_name}` : ""}
              </p>
              <p><strong>UTC offset:</strong> {formatUtcOffset(profileInfo?.tz_offset_minutes ?? null)}</p>
              <p><strong>City of birth:</strong> {profileInfo?.birth_place ?? "—"}</p>
              <p><strong>Longitude:</strong> {profileInfo?.birth_lng ?? "—"}</p>
              <p><strong>Latitude:</strong> {profileInfo?.birth_lat ?? "—"}</p>
              <button className="btn-ghost" onClick={() => setShowEditForm((v) => !v)}>
                {showEditForm ? "Close" : "Edit profile"}
              </button>
            </article>
          </div>

          {showEditForm ? (
            <section className="profile-card">
        <div className="profile-header">
          <div>
            <p className="eyebrow">Edit</p>
            <h2>Update your birth data</h2>
            <p className="lead">
              Update your details and re‑calculate your profile.
            </p>
        </div>
        <div className="profile-badge">
            <span>{profileDirty ? "Changes" : "Ready"}</span>
        </div>
        </div>

        <div className="profile-grid">
          <div className="profile-field">
            <label>Date of birth</label>
            <Flatpickr
              className="flatpickr-input"
              options={{
                dateFormat: "Y-m-d",
                ...(dateLocale.startsWith("sv") ? { locale: Swedish } : {}),
                defaultDate: profileForm.birthDate || defaultBirthDate,
              }}
              onChange={handleBirthDateChange}
              value={profileForm.birthDate}
            />
            <p className="help-text">Format: YYYY-MM-DD</p>
          </div>
          <div className="profile-field">
            <label>Time of birth</label>
            <input
              type="time"
              value={profileForm.birthTime}
              onChange={(e) => handleProfileChange("birthTime", e.target.value)}
              disabled={profileForm.unknownTime}
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={profileForm.unknownTime}
                onChange={(e) => handleProfileChange("unknownTime", e.target.checked)}
              />
              Unknown time
            </label>
          </div>
          <div className="profile-field">
            <label>City of birth</label>
            <div className="autocomplete">
              <input
                type="text"
                placeholder="City, country"
                value={profileForm.birthPlace}
                onChange={(e) => handleProfileChange("birthPlace", e.target.value)}
              />
              {placeLoading ? <div className="autocomplete-status">Searching…</div> : null}
              {placeResults.length ? (
                <ul className="autocomplete-list">
                  {placeResults.map((place) => (
                    <li key={place.id}>
                      <button type="button" onClick={() => handlePlaceSelect(place)}>
                        {place.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="toggle-row">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={showCoords}
                  onChange={(e) => setShowCoords(e.target.checked)}
                />
                Enter coordinates
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={showMap}
                  onChange={(e) => setShowMap(e.target.checked)}
                />
                Pick on map
              </label>
            </div>
          </div>
          {showCoords ? (
            <div className="profile-field">
              <label>Coordinates</label>
              <div className="coord-row">
                <input
                  type="text"
                  placeholder="Lat"
                  value={profileForm.birthLat}
                  onChange={(e) => handleProfileChange("birthLat", e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Lng"
                  value={profileForm.birthLng}
                  onChange={(e) => handleProfileChange("birthLng", e.target.value)}
                />
              </div>
              <button className="btn-ghost" type="button" onClick={useDeviceLocation}>
                Use my location
              </button>
            </div>
          ) : null}
        </div>

        {showMap ? (
          <div className="map-panel">
            <div className="map-header">
              <h3>Pick a location</h3>
              <p>Click to set an approximate coordinate.</p>
            </div>
            <div className="map-canvas" role="button" tabIndex={0}>
              <MapContainer
                center={mapLatLng ?? { lat: 59.3293, lng: 18.0686 }}
                zoom={mapLatLng ? 10 : 4}
                scrollWheelZoom={false}
                className="map-leaflet"
              >
                <TileLayer
                  attribution="&copy; OpenStreetMap contributors"
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <MapClickHandler onPick={handleMapPick} />
                {mapLatLng ? <Marker position={mapLatLng} /> : null}
              </MapContainer>
            </div>
          </div>
        ) : null}

        <div className="profile-actions">
          <button className="btn-primary" onClick={saveProfile} disabled={profileLoading}>
            Save profile
          </button>
          {profileStatus ? <span className="status">{profileStatus}</span> : null}
          {profileError ? <span className="status bad">{profileError}</span> : null}
        </div>
      </section>
          ) : null}

          <div className="background-grid">
            <article className="background-block">
              <h3>Astrology</h3>
              <p>
                We use Swiss Ephemeris (swisseph) for planetary positions. You enter date, time,
                and place. Positions are calculated in degrees of the tropical zodiac.
              </p>
              <p>
                Houses are calculated with the Placidus system. Ascendant (AC) and Midheaven (MC)
                come from the house calculation.
              </p>
              <p>
                Aspects (conjunction, sextile, square, trine, opposition) are computed by angular
                distance between planets.
              </p>
            </article>

            <article className="background-block">
              <h3>Time &amp; timezone</h3>
              <p>
                We use historical timezone data (timezone-support) to calculate the correct UTC
                offset for your exact date and location.
              </p>
              <p>
                Older dates can differ from apps that apply modern DST rules retroactively. We
                use historically accurate rules.
              </p>
            </article>

            <article className="background-block">
              <h3>Human Design</h3>
              <p>
                Human Design is calculated with natalengine. It uses astronomical positions
                (Meeus algorithms) to compute your type, profile, authority, centers, gates,
                and channels.
              </p>
              <p>
                Results are stored so your profile loads instantly next time.
              </p>
            </article>

            <article className="background-block">
              <h3>Chinese zodiac</h3>
              <p>
                The Chinese zodiac is based on your birth year and follows a simple 12‑year cycle.
              </p>
            </article>
          </div>
        </section>
      ) : null}

      {!isProfilePage && !isSettingsPage ? (
      <>
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
      </>
      ) : null}
    </main>
  );
}
