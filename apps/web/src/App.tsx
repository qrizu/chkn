import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  name?: string | null;
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

type HdCenterKey =
  | "head"
  | "ajna"
  | "throat"
  | "g"
  | "ego"
  | "spleen"
  | "sacral"
  | "solar"
  | "root";

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
    click: (event: L.LeafletMouseEvent) => {
      onPick(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
};

const normalizeCenterName = (name: string): HdCenterKey | null => {
  const raw = name.toLowerCase().replace(/\s+/g, "");
  if (raw.includes("head") || raw.includes("crown")) return "head";
  if (raw.includes("ajna")) return "ajna";
  if (raw.includes("throat")) return "throat";
  if (raw === "g" || raw.includes("identity") || raw.includes("gcenter")) return "g";
  if (raw.includes("heart") || raw.includes("ego") || raw.includes("will")) return "ego";
  if (raw.includes("spleen")) return "spleen";
  if (raw.includes("sacral")) return "sacral";
  if (raw.includes("solar") || raw.includes("emotional")) return "solar";
  if (raw.includes("root")) return "root";
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
  const [hdPageInsights, setHdPageInsights] = useState<ProfileInsights | null>(null);
  const [hdPageLoading, setHdPageLoading] = useState(false);
  const [hdPageError, setHdPageError] = useState<string | null>(null);
  const [hdPageProfile, setHdPageProfile] = useState<ProfilePayload | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(true);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [modal, setModal] = useState<{
    title: string;
    subtitle?: string;
    body: string;
    actions?: { label: string; href: string }[];
    icon?: React.ReactNode;
  } | null>(null);
  const [mapLatLng, setMapLatLng] = useState<{ lat: number; lng: number } | null>(null);
  const [placeResults, setPlaceResults] = useState<PlaceResult[]>([]);
  const [placeLoading, setPlaceLoading] = useState(false);
  const [showCoords, setShowCoords] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [isHdOpen, setIsHdOpen] = useState(false);
  const [isHdChartOpen, setIsHdChartOpen] = useState(false);
  const userInitial = (profileInfo?.name ?? profileInfo?.username ?? "?")
    .trim()
    .charAt(0)
    .toUpperCase();
  const avatarFilename =
    (profileInfo?.username ? `${profileInfo.username.toLowerCase()}.jpg` : "Default.jpg");
  const avatarUrl = `/avatars/${avatarFilename}`;
  const [profileForm, setProfileForm] = useState({
    birthDate: "",
    birthTime: "",
    unknownTime: false,
    birthPlace: "",
    birthLat: "",
    birthLng: "",
  });
  const lastSavedRef = useRef<string>("");
  const hdCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const draftKey = "chkn.profileDraft";
  const pathname = window.location.pathname;
  const isProfilePage = pathname === "/" || pathname.startsWith("/profile");
  const isSettingsPage = pathname.startsWith("/settings") || pathname.startsWith("/background");
  const isHumanDesignPage = pathname.startsWith("/human-design");
  const isLobbyPage = pathname.startsWith("/lobby");
  const hdPageUserId = isHumanDesignPage
    ? window.location.pathname.replace("/human-design", "").replace(/^\/+/, "")
    : "";
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

  const openModal = (
    title: string,
    body: string,
    subtitle?: string,
    actions?: { label: string; href: string }[],
    icon?: React.ReactNode
  ) => {
    setModal({ title, body, subtitle, actions, icon });
  };

  const getModalCalcNote = (title: string) => {
    const lower = title.toLowerCase();
    const astroTitles = [
      "sun",
      "moon",
      "mercury",
      "venus",
      "mars",
      "jupiter",
      "saturn",
      "uranus",
      "neptune",
      "pluto",
      "ascendant",
    ];
    const isHouse = lower.startsWith("house") || lower.includes("house");
    const isSign = [
      "aries",
      "taurus",
      "gemini",
      "cancer",
      "leo",
      "virgo",
      "libra",
      "scorpio",
      "sagittarius",
      "capricorn",
      "aquarius",
      "pisces",
    ].some((s) => lower.includes(s));

    if (astroTitles.includes(lower) || isHouse || isSign) {
      return "How it’s calculated: we use your birth date, time, and location to compute planetary positions in the tropical zodiac, then place them into Placidus houses. The Ascendant is the zodiac sign rising on the eastern horizon at the moment you were born.";
    }
    if (lower.includes("human design") || ["energy type", "strategy", "authority", "profile"].includes(lower)) {
      return "How it’s calculated: Human Design uses astronomical positions at birth (and ~88 days before birth for the design chart). We compute gates, centers, type, profile, and authority from those positions.";
    }
    if (lower.includes("zodiac") || ["year animal", "yin/yang", "element"].includes(lower)) {
      return "How it’s calculated: the Chinese zodiac is based on your birth year in a 12‑year cycle, with fixed Yin/Yang polarity and element determined by the traditional system.";
    }
    if (lower.includes("account")) {
      return "How it’s calculated: account data comes from your inputed values in your user profile, check in the settings to view, verify or change your variables, it is important with correct city and time, all calculations depend heavliy on that.";
    }
    return "How it’s calculated: this insight is derived from the profile data you provided at birth (date, time, and place) and the relevant calculation rules for this system.";
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
    Sun: "The Sun is your inner fire—identity, purpose, and the role you grow into.",
    Moon: "The Moon is your inner tide—feelings, needs, and what makes you feel safe.",
    Mercury: "Mercury is your mind’s voice—how you learn, think, and translate reality.",
    Venus: "Venus is your magnetism—love, values, and the beauty you move toward.",
    Mars: "Mars is your spark—drive, desire, and the way you push forward.",
    Jupiter: "Jupiter is your horizon—growth, faith, and the meaning you seek.",
    Saturn: "Saturn is your backbone—discipline, boundaries, and long‑term lessons.",
    Uranus: "Uranus is your lightning—change, freedom, and originality.",
    Neptune: "Neptune is your dream‑sea—intuition, imagination, and ideals.",
    Pluto: "Pluto is your underworld—power, depth, and transformation.",
    "North Node": "The North Node is your compass—growth direction and life theme.",
    Lilith: "Lilith is your untamed truth—raw instinct and bold self‑expression.",
    Chiron: "Chiron is your tender edge—the wound that becomes wisdom.",
  };

  const signMeaning: Record<string, string> = {
    Aries: "Aries carries a spark: bold, direct, and pioneering.",
    Taurus: "Taurus is the slow river: steady, grounded, and loyal.",
    Gemini: "Gemini is wind‑quick: curious, agile, and communicative.",
    Cancer: "Cancer is the hearth: caring, sensitive, and protective.",
    Leo: "Leo is a warm sun: expressive, proud, and radiant.",
    Virgo: "Virgo is the craft: precise, analytical, and improvement‑minded.",
    Libra: "Libra is the balance point: relational and fair‑minded.",
    Scorpio: "Scorpio is depth and alchemy: intense, private, transformative.",
    Sagittarius: "Sagittarius is the open road: adventurous and freedom‑seeking.",
    Capricorn: "Capricorn is the mountain path: disciplined and enduring.",
    Aquarius: "Aquarius is the future pulse: original and visionary.",
    Pisces: "Pisces is tide and dream: intuitive, empathetic, imaginative.",
  };

  const zodiacMeaning: Record<string, string> = {
    Rat: "The Rat is clever and quick; in you it can appear as nimble problem‑solving.",
    Ox: "The Ox is steady and enduring; in you it can feel like quiet strength.",
    Tiger: "The Tiger is bold and passionate; in you it can surge as fearless drive.",
    Rabbit: "The Rabbit is gentle and diplomatic; in you it can soften the room.",
    Dragon: "The Dragon is magnetic and visionary; in you it can feel like presence.",
    Snake: "The Snake is intuitive and strategic; in you it can read between the lines.",
    Horse: "The Horse is free and forward‑moving; in you it becomes momentum.",
    Goat: "The Goat is creative and empathetic; in you it feels like soft strength.",
    Monkey: "The Monkey is playful and bright; in you it turns to clever agility.",
    Rooster: "The Rooster is precise and proud; in you it becomes clarity.",
    Dog: "The Dog is loyal and protective; in you it feels like steadfast care.",
    Pig: "The Pig is generous and grounded; in you it becomes warm presence.",
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

  const houseSvgIcon = (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M8 22L24 8l16 14" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 22v18h24V22" fill="currentColor" opacity="0.65" />
    </svg>
  );

  const houseSvgIconSmall = (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M8 22L24 8l16 14" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 22v18h24V22" fill="currentColor" opacity="0.55" />
    </svg>
  );

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
    1: "1st House",
    2: "2nd House",
    3: "3rd House",
    4: "4th House",
    5: "5th House",
    6: "6th House",
    7: "7th House",
    8: "8th House",
    9: "9th House",
    10: "10th House",
    11: "11th House",
    12: "12th House",
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

  const humanDesignTypeDetail: Record<string, string> = {
    Generator:
      "You’re built for sustainable output and mastery. Your energy ignites when something truly lights you up, and grows brighter the longer you stay aligned.",
    "Manifesting Generator":
      "You’re multi‑passionate and fast. You respond to what excites you, then move like wind—quick to pivot, quick to learn.",
    Projector:
      "You’re here to guide and refine. Your gift is seeing what others miss and directing energy rather than spending it.",
    Manifestor:
      "You’re an initiator. You’re built to spark new paths and open doors, then let others carry the momentum.",
    Reflector:
      "You’re a mirror and a barometer. Your energy reflects the people and places around you—alignment depends on where you are and who you’re with.",
  };

  const humanDesignAuthorityDetail: Record<string, string> = {
    "Emotional Authority":
      "Clarity arrives in waves. Your truest decisions come after the tide has moved through you, not in the first surge.",
    "Sacral Authority":
      "You decide in the moment with a visceral yes/no. Your body response is the truth before the mind gets involved.",
    "Splenic Authority":
      "Your intuition speaks softly and instantly. When you feel a quiet nudge, trust it—waiting too long can blur it.",
    "Ego Authority":
      "Your willpower guides you. If you can commit with a full‑body yes, it’s right; if not, it drains you.",
    "Self‑Projected Authority":
      "Your identity and direction are your compass. Speaking it out loud helps you hear what’s true.",
    "Mental Authority":
      "You need to talk it out with the right people and environment. Clarity comes from dialogue, not isolation.",
    "Lunar Authority":
      "You need a full cycle to decide. Time and observation reveal what’s correct for you.",
  };

  const humanDesignStrategyDetail: Record<string, string> = {
    "Wait to Respond":
      "Let life come to you, then answer with your gut or inner clarity. Pushing first creates resistance.",
    "Wait to Respond, then Inform":
      "Respond first, then inform those affected. This softens friction when you move quickly.",
    "Wait for the Invitation":
      "Recognition is your green light. The right invitations save you energy and open the right doors.",
    Inform:
      "You move best when you let people know what you’re about to do. It clears the path and lowers pushback.",
    "Wait a Lunar Cycle":
      "Give yourself time. Clarity arrives by observing how different options feel across a full cycle.",
  };

  const humanDesignProfileDetail: Record<string, string> = {
    "1/3": "Researcher/Martyr: you learn by digging deep, then testing truth in real life.",
    "1/4": "Researcher/Opportunist: you build solid foundations and share them through your network.",
    "2/4": "Hermit/Opportunist: you need solitude to refine gifts, then share when invited.",
    "2/5": "Hermit/Heretic: you’re called out for solutions—choose carefully where you answer the call.",
    "3/5": "Martyr/Heretic: you learn by trial and error, then turn lessons into practical fixes.",
    "3/6": "Martyr/Role Model: your early experiments become wisdom you live and teach.",
    "4/6": "Opportunist/Role Model: relationships open doors; your path matures into leadership.",
    "4/1": "Opportunist/Investigator: a stable core identity with influence through community.",
    "5/1": "Heretic/Investigator: a practical problem‑solver anchored by solid facts.",
    "5/2": "Heretic/Hermit: people project on you—clarity and boundaries keep you true.",
    "6/2": "Role Model/Hermit: you step back to integrate, then emerge as a guide.",
    "6/3": "Role Model/Martyr: your wisdom is forged through lived experience.",
  };

  const humanDesignProfileExamples: Record<string, string> = {
    "1/3": "Example: You might research deeply first, then learn what works through hands‑on trial.",
    "1/4": "Example: You build a solid base, then your network helps opportunities find you.",
    "2/4": "Example: You need alone time to sharpen gifts, then share them when invited.",
    "2/5": "Example: People look to you for solutions—choose commitments carefully.",
    "3/5": "Example: You try, fail, adjust, and turn lessons into practical fixes.",
    "3/6": "Example: Early life is experimentation; later life becomes mentoring.",
    "4/6": "Example: Relationships open doors, and your path matures into leadership.",
    "4/1": "Example: You influence through community while holding a stable core identity.",
    "5/1": "Example: You’re asked to solve problems—your research keeps you grounded.",
    "5/2": "Example: You’re called out for help, but you need clear boundaries.",
    "6/2": "Example: You step back to integrate, then return as a quiet guide.",
    "6/3": "Example: Your authority grows from lived experience and resilience.",
  };

  const humanDesignExamples: Record<string, string> = {
    Projector:
      "Example: You may thrive as a strategist, coach, or director—seeing how to optimize a team without doing all the doing.",
    Generator:
      "Example: When a project lights you up, you can outlast others and build real mastery.",
    "Manifesting Generator":
      "Example: You might start a task, find a faster path, and pivot quickly—this is natural.",
    Manifestor:
      "Example: You might initiate a new idea at work, then step back once it’s moving.",
    Reflector:
      "Example: You often sense when a room feels off and can guide others toward alignment.",
  };

  const buildHumanDesignNarrative = () => {
    const type = insights?.summary_json?.human_design?.type ?? "";
    const strategy = insights?.summary_json?.human_design?.strategy ?? "";
    const authority = insights?.summary_json?.human_design?.authority ?? "";
    const profile = insights?.summary_json?.human_design?.profile ?? "";
    const role = insights?.summary_json?.human_design?.role ?? "";
    const definition = insights?.human_design_json?.definition ?? "";

    const parts = [
      type ? `Your Energy Type is ${type}. ${humanDesignTypeDetail[type] ?? ""}` : "",
      strategy ? `Your strategy is ${strategy}. ${humanDesignStrategyDetail[strategy] ?? ""}` : "",
      authority ? `Your authority is ${authority}. ${humanDesignAuthorityDetail[authority] ?? ""}` : "",
      profile
        ? `Your profile is ${profile}${role ? ` (${role})` : ""}. ${humanDesignProfileDetail[profile] ?? ""}`
        : "",
      profile ? humanDesignProfileExamples[profile] ?? "" : "",
      definition
        ? `Your definition is ${definition}. It shapes how you integrate information and connect with others.`
        : "",
      type ? humanDesignExamples[type] ?? "" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return parts;
  };

  const humanDesignTypeSignature: Record<string, string> = {
    Projector: "Success",
    Generator: "Satisfaction",
    "Manifesting Generator": "Satisfaction",
    Manifestor: "Peace",
    Reflector: "Surprise",
  };

  const humanDesignTypeNotSelf: Record<string, string> = {
    Projector: "Bitterness",
    Generator: "Frustration",
    "Manifesting Generator": "Frustration",
    Manifestor: "Anger",
    Reflector: "Disappointment",
  };

  const drawHdWave = useCallback(() => {
    const canvas = hdCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    const w = Math.floor(cssW * dpr);
    const h = Math.floor(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    ctx.clearRect(0, 0, w, h);

    const pad = 18 * dpr;
    const left = pad;
    const right = w - pad;
    const top = pad;
    const bottom = h - pad;
    const midY = (top + bottom) / 2;

    const amp = (0.32 + Math.random() * 0.1) * (bottom - top);
    const freq = 1.2 + Math.random() * 0.8;
    const phase = Math.random() * Math.PI * 2;

    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(right, top);
    ctx.moveTo(left, midY);
    ctx.lineTo(right, midY);
    ctx.moveTo(left, bottom);
    ctx.lineTo(right, bottom);
    const cols = 6;
    for (let i = 1; i < cols; i++) {
      const x = left + (i * (right - left)) / cols;
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = `${12 * dpr}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    ctx.textBaseline = "middle";
    ctx.fillText("High", left, top - 8 * dpr);
    ctx.fillText("Neutral", left, midY);
    ctx.fillText("Low", left, bottom + 8 * dpr);

    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 2.2 * dpr;
    ctx.beginPath();
    const width = right - left;
    const steps = 240;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = left + t * width;
      const y =
        midY -
        Math.sin(t * Math.PI * 2 * freq + phase) * amp -
        Math.sin(t * Math.PI * 2 * (freq * 0.33) + phase * 0.7) * (amp * 0.18);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.20)";
    ctx.lineWidth = 10 * dpr;
    ctx.beginPath();
    ctx.moveTo(left, midY);
    ctx.lineTo(right, midY);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = 2.4 * dpr;
    ctx.stroke();
  }, []);

  useEffect(() => {
    if (!isHdOpen) return;
    drawHdWave();
    const handleResize = () => drawHdWave();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [drawHdWave, isHdOpen]);

  const hdInsights = isHumanDesignPage ? hdPageInsights : insights;
  const hdType = hdInsights?.summary_json?.human_design?.type ?? "–";
  const hdStrategy = hdInsights?.summary_json?.human_design?.strategy ?? "–";
  const hdAuthority = hdInsights?.summary_json?.human_design?.authority ?? "–";
  const hdProfile = hdInsights?.summary_json?.human_design?.profile ?? "–";
  const hdRole = hdInsights?.summary_json?.human_design?.role ?? "";
  const hdDefinition = hdInsights?.human_design_json?.definition ?? "–";
  const hdProfileLabel =
    hdProfile !== "–" ? `${hdProfile}${hdRole ? ` (${hdRole})` : ""}` : "–";
  const hdTitleBits = [hdType, hdAuthority, hdProfileLabel, hdDefinition].filter(
    (value) => value && value !== "–"
  );
  const hdDeepDiveTitle = hdTitleBits.length
    ? `Riktigt nördig Deep Dive (${hdTitleBits.join(" • ")})`
    : "Riktigt nördig Deep Dive";
  const isEmotionalAuthority = hdAuthority.toLowerCase().includes("emotional");
  const isSplitDefinition = hdDefinition.toLowerCase().includes("split");
  const profileDetail = hdProfile !== "–" ? humanDesignProfileDetail[hdProfile] ?? "" : "";
  const profileExample = hdProfile !== "–" ? humanDesignProfileExamples[hdProfile] ?? "" : "";
  const strategyDetail =
    hdStrategy !== "–" ? humanDesignStrategyDetail[hdStrategy] ?? "" : "";
  const authorityDetail =
    hdAuthority !== "–" ? humanDesignAuthorityDetail[hdAuthority] ?? "" : "";
  const typeSignature = hdType !== "–" ? humanDesignTypeSignature[hdType] ?? "" : "";
  const typeNotSelf = hdType !== "–" ? humanDesignTypeNotSelf[hdType] ?? "" : "";
  const hdIncarnation =
    hdInsights?.human_design_json?.incarnationCross?.fullName ||
    hdInsights?.human_design_json?.incarnationCross?.name ||
    "–";
  const hdProfileSource = isHumanDesignPage ? hdPageProfile : profileInfo;
  const hdEmail = hdProfileSource?.email ?? "";

  const renderHdBodygraph = (svgRef?: React.Ref<SVGSVGElement>) => (
    <svg className="hd-bodygraph" viewBox="0 0 360 520" role="img" ref={svgRef}>
      <g className="hd-channels">
        {hdChannels.map((ch, idx) => {
          const centerPos: Record<HdCenterKey, { x: number; y: number }> = {
            head: { x: 180, y: 40 },
            ajna: { x: 180, y: 110 },
            throat: { x: 180, y: 185 },
            g: { x: 180, y: 260 },
            ego: { x: 250, y: 250 },
            spleen: { x: 110, y: 250 },
            sacral: { x: 180, y: 330 },
            solar: { x: 260, y: 330 },
            root: { x: 180, y: 420 },
          };
          const p1 = centerPos[ch.c1];
          const p2 = centerPos[ch.c2];
          return (
            <line
              key={`${ch.c1}-${ch.c2}-${idx}`}
              x1={p1.x}
              y1={p1.y}
              x2={p2.x}
              y2={p2.y}
              className="hd-channel"
            />
          );
        })}
      </g>
      <g className="hd-centers">
        <polygon
          className={`hd-center ${hdDefinedCenters.has("head") ? "defined" : ""}`}
          points="180,10 150,60 210,60"
        />
        <polygon
          className={`hd-center ${hdDefinedCenters.has("ajna") ? "defined" : ""}`}
          points="150,90 210,90 180,140"
        />
        <rect
          className={`hd-center ${hdDefinedCenters.has("throat") ? "defined" : ""}`}
          x="145"
          y="155"
          width="70"
          height="60"
          rx="8"
        />
        <polygon
          className={`hd-center ${hdDefinedCenters.has("g") ? "defined" : ""}`}
          points="180,220 220,260 180,300 140,260"
        />
        <polygon
          className={`hd-center ${hdDefinedCenters.has("ego") ? "defined" : ""}`}
          points="240,235 270,255 240,275"
        />
        <polygon
          className={`hd-center ${hdDefinedCenters.has("spleen") ? "defined" : ""}`}
          points="120,235 90,255 120,275"
        />
        <rect
          className={`hd-center ${hdDefinedCenters.has("sacral") ? "defined" : ""}`}
          x="145"
          y="300"
          width="70"
          height="60"
          rx="8"
        />
        <polygon
          className={`hd-center ${hdDefinedCenters.has("solar") ? "defined" : ""}`}
          points="250,300 290,330 250,360 210,330"
        />
        <rect
          className={`hd-center ${hdDefinedCenters.has("root") ? "defined" : ""}`}
          x="145"
          y="390"
          width="70"
          height="60"
          rx="8"
        />
      </g>
    </svg>
  );

  const hdReportData = useMemo(() => {
    const gates = hdInsights?.human_design_json?.gates ?? {};
    const personality = gates.personality ?? {};
    const design = gates.design ?? {};
    const planetOrder = [
      "sun",
      "earth",
      "moon",
      "northNode",
      "southNode",
      "mercury",
      "venus",
      "mars",
      "jupiter",
      "saturn",
      "uranus",
      "neptune",
      "pluto",
    ];
    const toGateEntry = (source: Record<string, any>, type: "P" | "D") =>
      planetOrder
        .map((planet) => {
          const item = source[planet];
          if (!item) return null;
          return {
            gate: item.gate ?? null,
            line: item.line ?? null,
            planet,
            type,
          };
        })
        .filter(Boolean) as Array<{ gate: number; line: number; planet: string; type: "P" | "D" }>;

    const personalityGates = toGateEntry(personality, "P");
    const designGates = toGateEntry(design, "D");
    const pGateSet = new Set(personalityGates.map((g) => g.gate));
    const dGateSet = new Set(designGates.map((g) => g.gate));

    const definedCenters =
      (hdInsights?.human_design_json?.centers?.definedNames ?? [])
        .map((name: string) => normalizeCenterName(name))
        .filter(Boolean) as HdCenterKey[];

    const activeChannels = (hdInsights?.human_design_json?.channels ?? [])
      .map((ch: any) => {
        const centers = Array.isArray(ch?.centers) ? ch.centers : [];
        const c1 = centers[0] ? normalizeCenterName(String(centers[0])) : null;
        const c2 = centers[1] ? normalizeCenterName(String(centers[1])) : null;
        if (!c1 || !c2 || c1 === c2) return null;
        const gates = Array.isArray(ch?.gates) ? ch.gates : [];
        const hasP = gates.some((g: number) => pGateSet.has(g));
        const hasD = gates.some((g: number) => dGateSet.has(g));
        const type = hasP && hasD ? "B" : hasP ? "P" : "D";
        return { centers: [c1, c2], gates, type };
      })
      .filter(Boolean) as Array<{ centers: HdCenterKey[]; gates: number[]; type: string }>;

    return {
      summary: {
        type: hdType,
        profile: hdProfileLabel,
        definition: hdDefinition,
        authority: hdAuthority,
        strategy: hdStrategy,
        notSelf: hdInsights?.human_design_json?.type?.notSelf ?? typeNotSelf ?? "—",
        incarnationCross: hdIncarnation,
      },
      user: {
        username:
          hdProfileSource?.username ??
          hdProfileSource?.name ??
          profileInfo?.username ??
          profileInfo?.name ??
          (hdPageUserId || "—"),
        birthDate:
          hdProfileSource?.birth_date ??
          profileInfo?.birth_date ??
          (profileForm.birthDate || null) ??
          "—",
        birthTime:
          hdProfileSource?.birth_time ??
          profileInfo?.birth_time ??
          (profileForm.birthTime || null) ??
          (hdProfileSource?.unknown_time || profileInfo?.unknown_time ? "Unknown" : "—"),
        tzOffsetMinutes:
          typeof hdInsights?.summary_json?.meta?.tz_offset_minutes === "number"
            ? hdInsights.summary_json.meta.tz_offset_minutes
            : typeof hdProfileSource?.tz_offset_minutes === "number"
              ? hdProfileSource.tz_offset_minutes
              : typeof profileInfo?.tz_offset_minutes === "number"
                ? profileInfo.tz_offset_minutes
                : null,
        city:
          hdProfileSource?.birth_place ??
          profileInfo?.birth_place ??
          (profileForm.birthPlace || null) ??
          "—",
        lat: (() => {
          const raw =
            hdProfileSource?.birth_lat ??
            profileInfo?.birth_lat ??
            null;
          const num = typeof raw === "number" ? raw : raw !== null && raw !== undefined ? Number(raw) : NaN;
          return Number.isFinite(num) ? num : null;
        })(),
        lng: (() => {
          const raw =
            hdProfileSource?.birth_lng ??
            profileInfo?.birth_lng ??
            null;
          const num = typeof raw === "number" ? raw : raw !== null && raw !== undefined ? Number(raw) : NaN;
          return Number.isFinite(num) ? num : null;
        })(),
      },
      chart: {
        activeChannels,
        definedCenters,
        personalityGates,
        designGates,
      },
    };
  }, [
    hdAuthority,
    hdDefinition,
    hdIncarnation,
    hdProfileLabel,
    hdStrategy,
    hdType,
    hdProfileSource,
    hdInsights?.human_design_json,
    profileInfo?.birth_date,
    profileInfo?.birth_time,
    profileInfo?.birth_place,
    profileInfo?.birth_lat,
    profileInfo?.birth_lng,
    profileInfo?.tz_offset_minutes,
    profileInfo?.unknown_time,
    profileInfo?.username,
    profileInfo?.name,
    profileForm.birthDate,
    profileForm.birthTime,
    profileForm.birthPlace,
    hdPageUserId,
    typeNotSelf,
  ]);

  const hdReportHash = useMemo(() => {
    try {
      return encodeURIComponent(JSON.stringify(hdReportData));
    } catch {
      return "";
    }
  }, [hdReportData]);

  const hdReportUrl = hdReportHash
    ? `/standalone-report.html#data=${hdReportHash}`
    : "/standalone-report.html";
  const hdReportPrintUrl = hdReportHash
    ? `/standalone-report.html#data=${hdReportHash}&print=1`
    : "/standalone-report.html#print=1";

  const hdEmailLink = useMemo(() => {
    const subject = "My Human Design Report";
    const body = [
      "Här är min Human Design‑rapport:",
      "",
      `Type: ${hdType}`,
      `Strategy: ${hdStrategy}`,
      `Authority: ${hdAuthority}`,
      `Profile: ${hdProfileLabel}`,
      `Definition: ${hdDefinition}`,
      `Incarnation Cross: ${hdIncarnation}`,
      "",
      `Rapport: ${window.location.origin}${hdReportUrl}`,
    ].join("\n");
    const to = hdEmail ? encodeURIComponent(hdEmail) : "";
    return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }, [
    hdAuthority,
    hdDefinition,
    hdEmail,
    hdIncarnation,
    hdProfileLabel,
    hdReportUrl,
    hdStrategy,
    hdType,
  ]);
  const hdDefinedCenters = useMemo(() => {
    const names = hdInsights?.human_design_json?.centers?.definedNames ?? [];
    const set = new Set<HdCenterKey>();
    names.forEach((n: string) => {
      const key = normalizeCenterName(n);
      if (key) set.add(key);
    });
    return set;
  }, [hdInsights?.human_design_json]);
  const hdChannels = useMemo(() => {
    const list = Array.isArray(hdInsights?.human_design_json?.channels)
      ? hdInsights?.human_design_json?.channels
      : [];
    return list
      .map((ch: any) => {
        const centers = Array.isArray(ch?.centers) ? ch.centers : [];
        const c1 = centers[0] ? normalizeCenterName(String(centers[0])) : null;
        const c2 = centers[1] ? normalizeCenterName(String(centers[1])) : null;
        if (!c1 || !c2 || c1 === c2) return null;
        return { c1, c2 };
      })
      .filter(Boolean) as Array<{ c1: HdCenterKey; c2: HdCenterKey }>;
  }, [hdInsights?.human_design_json]);

  const describeSign = (sign?: string | null) => {
    if (!sign) return "The sign shows how the energy expresses itself.";
    return signMeaning[sign] ?? "The sign shows how the energy expresses itself.";
  };

  const describeSignDeep = (sign?: string | null) => {
    if (!sign) return "The sign is the style of the energy—how it wants to move.";
    const tone = signTone[sign] ?? "expresses in its own unique way.";
    return `${signMeaning[sign] ?? "The sign is the style of the energy."} It often ${tone}`;
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
    const houseFocus = house ? houseDetail[house] ?? "a key life area." : "a key life area.";
    const houseSuffix = house
      ? ` It lands in the ${houseNames[house] ?? `house ${house}`} — the area of ${houseFocus}`
      : "";
    return `${planetText} ${signText}${houseSuffix} For you, this is where the story gathers its heat and asks to be lived.`.trim();
  };

  const describeAscendant = (sign?: string | null) => {
    const signText = describeSign(sign);
    return `The Ascendant is the “mask” you present to people and your first impression. ${signText} For you, it colors how others read you at a glance.`;
  };

  const describeAscendantDeep = (sign?: string | null) => {
    const signText = describeSignDeep(sign);
    return `The Ascendant is the doorway of your chart—how the world first meets you. ${signText} It shapes your style, presence, and the energy you cast when you enter a room.`;
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
  const insightsByUserUrl = useMemo(() => {
    const base = (import.meta.env.VITE_API_URL || "").trim();
    if (!base) return `${window.location.origin}/api/profile/insights`;
    const clean = base.replace(/\/$/, "");
    return clean.endsWith("/api") ? `${clean}/profile/insights` : `${clean}/api/profile/insights`;
  }, []);
  const profileByUserUrl = useMemo(() => {
    const base = (import.meta.env.VITE_API_URL || "").trim();
    if (!base) return `${window.location.origin}/api/profile`;
    const clean = base.replace(/\/$/, "");
    return clean.endsWith("/api") ? `${clean}/profile` : `${clean}/api/profile`;
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

  const fetchInsightsOnce = useCallback(async (setLoading = true) => {
    try {
      if (setLoading) setInsightsLoading(true);
      const res = await fetch(insightsUrl, { credentials: "include", cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok && data.insights) {
        setInsights(data.insights as ProfileInsights);
        return data.insights as ProfileInsights;
      } else if (!res.ok && res.status !== 401) {
        setInsightsError(data?.error || "Kunde inte läsa profiler.");
      }
    } catch {
      setInsightsError("Kunde inte läsa profiler.");
    } finally {
      if (setLoading) setInsightsLoading(false);
    }
    return null;
  }, [insightsUrl]);

  useEffect(() => {
    fetchInsightsOnce();
  }, [fetchInsightsOnce]);

  const pollInsights = useCallback(
    async (attempts = 4, delayMs = 700) => {
      for (let i = 0; i < attempts; i += 1) {
        const next = await fetchInsightsOnce(i === 0);
        if (next) return next;
        if (i < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      return null;
    },
    [fetchInsightsOnce]
  );

  useEffect(() => {
    if (!isHumanDesignPage || !hdPageUserId) return;
    let active = true;
    const loadHdPageInsights = async () => {
      try {
        setHdPageLoading(true);
        setHdPageError(null);
        const [insightsRes, profileRes] = await Promise.all([
          fetch(`${insightsByUserUrl}/${encodeURIComponent(hdPageUserId)}`, {
            credentials: "include",
          }),
          fetch(`${profileByUserUrl}/${encodeURIComponent(hdPageUserId)}`, {
            credentials: "include",
          }),
        ]);
        const insightsData = await insightsRes.json().catch(() => null);
        const profileData = await profileRes.json().catch(() => null);
        if (!insightsRes.ok || !insightsData?.ok) {
          throw new Error(insightsData?.error || "Kunde inte läsa insights.");
        }
        if (active) {
          setHdPageInsights(insightsData.insights ?? null);
          setHdPageProfile(profileData?.profile ?? null);
        }
      } catch (err) {
        if (active) {
          setHdPageError(err instanceof Error ? err.message : "Kunde inte läsa insights.");
          setHdPageInsights(null);
          setHdPageProfile(null);
        }
      } finally {
        if (active) setHdPageLoading(false);
      }
    };
    loadHdPageInsights();
    return () => {
      active = false;
    };
  }, [hdPageUserId, insightsByUserUrl, isHumanDesignPage, profileByUserUrl]);

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
    if (!profileForm.birthLat.trim() || !profileForm.birthLng.trim()) {
      setProfileError("Välj plats från listan eller ange koordinater.");
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
          cache: "no-store",
        });
        const calcData = await calcRes.json().catch(() => null);
        if (!calcRes.ok || !calcData?.ok) {
          setProfileStatus("Saved, but calculation failed.");
        } else {
          setProfileStatus("Saved and calculated.");
          // Always fetch the persisted insights shape after calc completes.
          await pollInsights();
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
          <a className={isLobbyPage ? "nav-link active" : "nav-link"} href="/lobby">
            Lobby
          </a>
          <a className={isProfilePage ? "nav-link active" : "nav-link"} href="/profile">
            Profile
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
                  <div className="modal-title">
                    {modal.icon ? <span className="modal-icon">{modal.icon}</span> : null}
                    <div>
                      <h3>{modal.title}</h3>
                    {modal.subtitle ? <p className="modal-subtitle">{modal.subtitle}</p> : null}
                    </div>
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
                  <p className="modal-note">{getModalCalcNote(modal.title)}</p>
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
          {isHdChartOpen ? (
            <div
              className="modal-backdrop"
              role="dialog"
              aria-modal="true"
              onClick={() => setIsHdChartOpen(false)}
            >
              <div className="modal hd-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <div className="modal-title">
                    <div>
                      <h3>Human Design Chart</h3>
                      <p className="modal-subtitle">
                        Genererad från din födelsedata (födelsedatum, tid och plats).
                      </p>
                    </div>
                  </div>
                  <button
                    className="modal-close"
                    onClick={() => setIsHdChartOpen(false)}
                    aria-label="Stäng"
                    title="Stäng"
                  >
                    ×
                  </button>
                </div>
                <div className="modal-body hd-modal-body">
                  <iframe
                    className="hd-report-frame"
                    title="Human Design Report"
                    src={hdReportUrl}
                  />
                  <div className="modal-actions hd-modal-actions">
                    <a className="btn-primary" href={hdReportPrintUrl} target="_blank" rel="noreferrer">
                      Ladda ner rapport (PDF)
                    </a>
                    <a className="btn-ghost" href={hdEmailLink}>
                      Skicka till min email
                    </a>
                  </div>
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
                  "Your username and email are managed in Sputnet's SpaceDatabase. You can view or update your security  and other settings there.",
                  undefined,
                  [{ label: "Open account page", href: `${authBaseUrl}/if/user/` }]
                )
              }
            >
              <div className="summary-card-header">
                <h3>Account</h3>
              </div>
              <div className="summary-items">
                <div className="summary-item">
                  <button
                    type="button"
                    className="summary-icon avatar-icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      openModal(
                        "Account avatar",
                        `Your avatar is tied to your Ytzy profile.\n\nUsername: ${profileInfo?.username ?? "—"}\nEmail: ${profileInfo?.email ?? "—"}\n\nTo change avatar or account details, open your Sputnet Space User Page.`,
                        undefined,
                        [{ label: "Open account page", href: `${authBaseUrl}/if/user/` }],
                        <img
                          src={avatarUrl}
                          alt={profileInfo?.username ? `${profileInfo.username} avatar` : "Avatar"}
                          onError={(ev) => {
                            ev.currentTarget.src = "/avatars/Default.jpg";
                          }}
                        />
                      );
                    }}
                  >
                    <img
                      src={avatarUrl}
                      alt={profileInfo?.username ? `${profileInfo.username} avatar` : "Avatar"}
                      onError={(e) => {
                        e.currentTarget.src = "/avatars/Default.jpg";
                      }}
                    />
                  </button>
                  <div>
                    <p className="summary-label">Username</p>
                    <p className="summary-value">{profileInfo?.username ?? "—"}</p>
                  </div>
                </div>
                <div className="summary-item">
                  <span className="summary-icon">✉</span>
                  <div>
                    <p className="summary-label">Email</p>
                    <p className="summary-value">
                      {profileInfo?.email ? (
                        <a href={`mailto:${profileInfo.email}`}>Email</a>
                      ) : (
                        "—"
                      )}
                    </p>
                  </div>
                </div>
                <div className="summary-item">
                  <span className="summary-icon">✎</span>
                  <div>
                    <p className="summary-label">Edit</p>
                    <p className="summary-value">Change account</p>
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
                      (() => {
                        const type = insights?.summary_json?.human_design?.type ?? "";
                        const base =
                          insights?.human_design_json?.type?.description ||
                          "Energy type describes your overall life force and how you best interact with the world.";
                        const extra = type ? humanDesignTypeDetail[type] ?? "" : "";
                        const example = type ? humanDesignExamples[type] ?? "" : "";
                        return `${base} ${extra} ${example} For you, this is your baseline way of operating and how others feel your energy.`.trim();
                      })()
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
                      (() => {
                        const strategy =
                          insights?.human_design_json?.type?.strategy ||
                          insights?.summary_json?.human_design?.strategy ||
                          "";
                        const base =
                          "Strategy is your practical path for decisions and less resistance.";
                        const extra = strategy ? humanDesignStrategyDetail[strategy] ?? "" : "";
                        return `${base} ${strategy ? `Strategy: ${strategy}.` : ""} ${extra} It’s the path that reduces friction and helps you align your actions.`.trim();
                      })()
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
                      (() => {
                        const authority = insights?.summary_json?.human_design?.authority ?? "";
                        const base =
                          insights?.human_design_json?.authority?.description ||
                          "Authority shows where your most reliable inner compass lives.";
                        const extra = authority ? humanDesignAuthorityDetail[authority] ?? "" : "";
                        return `${base} ${authority ? `Authority: ${authority}.` : ""} ${extra} It’s your most trusted decision‑making center over time.`.trim();
                      })()
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
                        `${
                          zodiacMeaning[insights?.summary_json?.chinese_zodiac ?? ""] ||
                          "Your year animal is based on your birth year and reflects archetypal traits in Chinese tradition."
                        } It often shows up as both your natural temperament and how you move through community. When it’s strong, you’ll notice it as your instinctive style under pressure or in new situations.\n\n${
                          zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""] ?
                            `Animal: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.animalChar}\nEarthly Branch: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.earthlyBranch}\nTrine: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.trine} (a group of three animals that share a similar rhythm and element)` :
                            ""
                        }`,
                        undefined,
                        undefined,
                        zodiacIcons[insights?.summary_json?.chinese_zodiac ?? ""] ?? "🐉"
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
                          `Yin/Yang describes the polarity of the animal.\n\nYin/Yang: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.yinYang}\nYin tends to be receptive and reflective; Yang tends to be expressive and outward. This polarity colors how you pace yourself, relate to others, and process experiences.`,
                          undefined,
                          undefined,
                          "☯︎"
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
                          `The fixed element adds a deeper tone to the animal.\n\nElement: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.element}\nThis element colors your strengths, challenges, and how you respond under pressure.`,
                          undefined,
                          undefined,
                          elementIcons[zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.element] ?? null
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
        <div className="summary-card deep-dive-astro">
          <h3>Go Deeper</h3>
          <p className="summary-detail">
            Your chart is calculated from birth date, exact time, and location to place each planet in a sign and a house.
            Think of it as a layered map: planets are the actors, signs are their style, and houses are the stages where
            the story unfolds in real life.
          </p>
          <p className="summary-detail">
            The Houses & Planets chart below shows where your energy concentrates. Tap a placement to see the deeper
            meaning: the planet’s drive, the sign’s tone, and the house’s life area. Aspects are the conversations between
            planets—easy angles feel natural, tense ones create friction that drives growth. Together, these layers reveal
            your patterns, your strengths, and the kinds of situations that shape you most.
          </p>
        </div>
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
                        row.sign ?? "Sign",
                        (() => {
                          const signText = describeSignDeep(row.sign);
                          const list = [
                            row.ascendant ? "Ascendant" : null,
                            ...row.planets.map((p) => p.name),
                          ].filter(Boolean);
                          const planetText = list.length
                            ? `In your chart, ${row.sign} hosts ${list.join(", ")}.`
                            : `In your chart, ${row.sign} doesn’t host any planets.`;
                          const houseText = houseNames[row.house]
                            ? `This sign sits in the ${houseNames[row.house]}.`
                            : "";
                          return `${signText} ${planetText} ${houseText}`.trim();
                        })(),
                        houseNames[row.house],
                        undefined,
                        row.signSymbol
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
                          (() => {
                            const base = describeAscendantDeep(row.sign);
                            const houseText = `It anchors the 1st House — the area of ${houseDetail[1]}.`;
                            const signText = row.sign
                              ? `In ${row.sign}, it comes across as ${signTone[row.sign] ?? "a distinct personal style"}.`
                              : "";
                            return `${base} ${houseText} ${signText}`.trim();
                          })(),
                          ascLon ? `${row.sign ?? "–"}, ${formatDegree(ascLon)} · 1st House` : undefined,
                          undefined,
                          "↥"
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
                            (() => {
                              const planetText = planetMeaning[p.name] ?? "This planet describes a life theme.";
                              const houseText = row.house
                                ? `It lives in the ${houseNames[row.house]} — the area of ${houseDetail[row.house]}.`
                                : "";
                              const sign = p.sign || row.sign;
                              const signText = sign
                                ? `In ${sign}, it tends to ${signTone[sign] ?? "express in its own style"}.`
                                : "";
                              return `${planetText} ${houseText} ${signText}`.trim();
                            })(),
                            planetSubtitle(p.name),
                            undefined,
                            p.symbol
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
                        houseNames[row.house] ?? `House ${row.house}`,
                        (() => {
                          const base = houseMeaning[row.house] ?? "This house describes a life area.";
                          const detail = houseDetail[row.house] ? `It focuses on ${houseDetail[row.house]}` : "";
                          const signText = row.sign
                            ? `The sign on this house is ${row.sign}: ${describeSignDeep(row.sign)}`
                            : "";
                          const list = [
                            row.ascendant ? "Ascendant" : null,
                            ...row.planets.map((p) => p.name),
                          ].filter(Boolean);
                          const planetText = list.length
                            ? `It hosts ${list.join(", ")}.`
                            : "It currently holds no planets.";
                          return `${base} ${detail} ${signText} ${planetText}`.trim();
                        })(),
                        houseNames[row.house] ?? `house ${row.house}`,
                        undefined,
                        <span className="modal-house-icon">
                          {houseSvgIcon}
                          <span className="modal-house-number">{row.house}</span>
                        </span>
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
                          <div className="detail-meta">
                            <span className="detail-chip">
                              <span className="chip-icon">{signSymbolFor(p.sign ?? null)}</span>
                              {p.sign ?? "–"}
                            </span>
                            <span className="detail-chip">
                              <span className="chip-icon house-mini">{houseSvgIconSmall}</span>
                              {houseNames[p.house] ?? `House ${p.house}`}
                            </span>
                          </div>
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
                      <div className="detail-meta">
                        <span className="detail-chip">
                          <span className="chip-icon">{signSymbolFor(ascSign ?? null)}</span>
                          {ascSign ?? "–"}
                        </span>
                        <span className="detail-chip">
                          <span className="chip-icon house-mini">{houseSvgIconSmall}</span>
                          1st House
                        </span>
                      </div>
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

      {!profileMissing ? (
      <section className="profile-card profile-extras">
        <p className="eyebrow">Deep Dive</p>
        <div className="summary-stack">
          <section className="hd-card" aria-labelledby="hd-title">
            <h2 id="hd-title">Deep Dive - Human Design</h2>

            <div className="hd-grid">
              <div className="hd-item">
                <div className="hd-icon">⚡</div>
                <div className="hd-meta">
                  <div className="hd-label">Energy Type</div>
                  <div className="hd-value">{hdType}</div>
                </div>
              </div>

              <div className="hd-item">
                <div className="hd-icon">↳</div>
                <div className="hd-meta">
                  <div className="hd-label">Strategy</div>
                  <div className="hd-value">{hdStrategy}</div>
                </div>
              </div>

              <div className="hd-item">
                <div className="hd-icon">◎</div>
                <div className="hd-meta">
                  <div className="hd-label">Authority</div>
                  <div className="hd-value">{hdAuthority}</div>
                </div>
              </div>

              <div className="hd-item">
                <div className="hd-icon">◈</div>
                <div className="hd-meta">
                  <div className="hd-label">Profile</div>
                  <div className="hd-value">{hdProfileLabel}</div>
                </div>
              </div>
            </div>

            <div className="hd-body">
              <p>{buildHumanDesignNarrative()}</p>
            </div>

            <div className="hd-actions">
              <button
                className="hd-btn hd-btn-small"
                id="aboutHdBtn"
                type="button"
                aria-expanded={isHdOpen}
                aria-controls="hd-deeper"
                onClick={() => setIsHdOpen((prev) => !prev)}
              >
                About Human Design
                <span className={`hd-btn-caret${isHdOpen ? " open" : ""}`} aria-hidden="true">
                  ▾
                </span>
              </button>
              <button
                className="hd-btn hd-btn-primary"
                type="button"
                onClick={() => setIsHdChartOpen(true)}
              >
                Create Chart
              </button>
            </div>

            <div className="hd-deeper" id="hd-deeper" hidden={!isHdOpen}>
              <h3>{hdDeepDiveTitle}</h3>

              <div className="hd-chartwrap">
                <div className="hd-charthead">
                  <div>
                    <div className="hd-charttitle">Bodygraph</div>
                    <div className="hd-chartsub">
                      Definierade centers och kanaler markerade från födelsedatan.
                    </div>
                  </div>
                </div>
                <div className="hd-bodygraph-wrap" aria-label="Human Design bodygraph">
                  {renderHdBodygraph()}
                </div>
              </div>

              {isEmotionalAuthority ? (
                <div className="hd-chartwrap" role="group" aria-label="Emotional Authority Wave chart">
                  <div className="hd-charthead">
                    <div>
                      <div className="hd-charttitle">Emotional Authority Wave</div>
                      <div className="hd-chartsub">
                        Klarhet tenderar att komma efter toppen/dalen — inte i första impulsen.
                      </div>
                    </div>
                    <button className="hd-mini" type="button" onClick={drawHdWave}>
                      Redraw
                    </button>
                  </div>

                  <canvas
                    ref={hdCanvasRef}
                    className="hd-canvas"
                    height={220}
                    aria-label="Wave chart"
                  />

                  <div className="hd-chartlegend" aria-hidden="true">
                    <span className="pill">High</span>
                    <span className="pill">Neutral / Clarity zone</span>
                    <span className="pill">Low</span>
                  </div>

                  <p className="hd-note">
                    Tips: använd detta som “decision hygiene”. Vänta minst en natt (ibland 2–3 dygn)
                    och känn om ditt ja/nej är stabilt över flera lägen.
                  </p>
                </div>
              ) : (
                <div className="hd-chartwrap" role="group" aria-label="Authority focus">
                  <div className="hd-charthead">
                    <div>
                      <div className="hd-charttitle">
                        {hdAuthority !== "–" ? `${hdAuthority} focus` : "Authority focus"}
                      </div>
                      <div className="hd-chartsub">
                        {authorityDetail ||
                          "Authority shows where your most reliable inner compass lives."}
                      </div>
                    </div>
                  </div>
                  <p className="hd-note">
                    Tips: ge beslut tid och låt kroppen bekräfta över flera lägen.
                  </p>
                </div>
              )}

              <div className="hd-section">
                <h4>{hdType !== "–" ? `${hdType} (kort men nördigt)` : "Energy Type (kort men nördigt)"}</h4>
                <ul>
                  <li>
                    <strong>Signature:</strong> {typeSignature || "—"}{" "}
                    <strong>Not-self:</strong> {typeNotSelf || "—"}.
                  </li>
                  <li>
                    <strong>Strategi i praktiken:</strong>{" "}
                    {strategyDetail || "Strategi är din praktiska väg till mindre friktion."}
                  </li>
                </ul>
              </div>

              <div className="hd-section">
                <h4>{hdProfile !== "–" ? `Profile ${hdProfileLabel}` : "Profile"}</h4>
                <ul>
                  <li>
                    <strong>Profiltext:</strong>{" "}
                    {profileDetail || "Profile describes how you learn, relate, and mature over time."}
                  </li>
                  <li>{profileExample || "Exempel: Din profil visar hur relationer och erfarenheter formar din roll."}</li>
                </ul>
              </div>

              <div className="hd-section">
                <h4>{hdDefinition !== "–" ? `${hdDefinition} (nördnotis)` : "Definition (nördnotis)"}</h4>
                <ul>
                  {isSplitDefinition ? (
                    <>
                      <li>
                        Två “öar” i din definition som gärna kopplas ihop via rätt personer/miljöer
                        (bridging).
                      </li>
                      <li>
                        När den bryggas: “aha, nu sitter allt” – ofta märkbart i samarbete.
                      </li>
                    </>
                  ) : (
                    <>
                      <li>
                        {hdDefinition !== "–"
                          ? `Din definition är ${hdDefinition}. Den beskriver hur dina center hänger ihop och hur du processar information.`
                          : "Din definition beskriver hur dina center hänger ihop och hur du processar information."}
                      </li>
                      <li>
                        Rätt miljö och samarbete kan göra att allt faller på plats snabbare.
                      </li>
                    </>
                  )}
                </ul>
              </div>
            </div>
          </section>

          <div className="summary-card zodiac-card">
            <h3>Deep Dive - Chinese Zodiac</h3>
            <div className="summary-items">
              <div className="zodiac-stack">
                <button
                  type="button"
                  className="summary-item zodiac-row-button"
                  onClick={() =>
                    openModal(
                      "Year animal",
                      `${
                        zodiacMeaning[insights?.summary_json?.chinese_zodiac ?? ""] ||
                        "Your year animal is based on your birth year and reflects archetypal traits in Chinese tradition."
                      } It often shows up as both your natural temperament and how you move through community. When it’s strong, you’ll notice it as your instinctive style under pressure or in new situations.\n\n${
                        zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""] ?
                          `Animal: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.animalChar}\nEarthly Branch: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.earthlyBranch}\nTrine: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.trine} (a group of three animals that share a similar rhythm and element)` :
                          ""
                      }`,
                      undefined,
                      undefined,
                      zodiacIcons[insights?.summary_json?.chinese_zodiac ?? ""] ?? "🐉"
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
                        `Yin/Yang describes the polarity of the animal.\n\nYin/Yang: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.yinYang}\nYin tends to be receptive and reflective; Yang tends to be expressive and outward. This polarity colors how you pace yourself, relate to others, and process experiences.`,
                        undefined,
                        undefined,
                        "☯︎"
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
                        `The fixed element adds a deeper tone to the animal.\n\nElement: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.element}\nThis element colors your strengths, challenges, and how you respond under pressure.`,
                        undefined,
                        undefined,
                        elementIcons[zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.element] ?? null
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
            <p className="summary-detail">
              {insights?.summary_json?.chinese_zodiac
                ? `${insights?.summary_json?.chinese_zodiac} is the year animal tied to your birth year. It offers a broad lens on temperament, social rhythm, and how you move through change.`
                : "Your year animal offers a broad lens on temperament and how you move through change."}{" "}
              {zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]?.element
                ? `The ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.element.toLowerCase()} element adds a steady undertone that colors your strengths and challenges.`
                : ""}{" "}
              {zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]?.yinYang
                ? `The ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.yinYang.toLowerCase()} polarity hints at whether your energy tends to be more receptive or expressive in daily life.`
                : ""}
            </p>
          </div>
        </div>
      </section>
          ) : null}
        </>
      ) : null}

      {isHumanDesignPage ? (
        <section className="profile-card profile-extras">
          <div className="profile-header">
            <div>
              <p className="eyebrow">Human Design</p>
              <h2>Human Design Report</h2>
              <p className="lead">
                En tydlig sammanställning av din chart, med bodygraph, gates, channels och center.
              </p>
            </div>
          </div>

          {hdPageLoading ? <p>Laddar rapport...</p> : null}
          {hdPageError ? <p className="status bad">{hdPageError}</p> : null}

          {!hdPageLoading && !hdPageError ? (
            <>
              <iframe
                className="hd-report-frame"
                title="Human Design Report"
                src={hdReportUrl}
              />
              <div className="modal-actions hd-modal-actions">
                <a className="btn-primary" href={hdReportPrintUrl} target="_blank" rel="noreferrer">
                  Ladda ner rapport (PDF)
                </a>
                <a className="btn-ghost" href={hdEmailLink}>
                  Skicka till min email
                </a>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {isSettingsPage ? (
        <section className="profile-card background-card">
          <div className="profile-header">
            <div>
              <p className="eyebrow">Settings</p>
              <h2>Settings</h2>
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

      {isLobbyPage ? (
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
        <h3>Debug: sputnet.space</h3>
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
