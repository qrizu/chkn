import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
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

type TarotDailyDraw = {
  cardNumber: number;
  cardName: string;
  orientation: "upright" | "reversed";
  imageUrl: string;
  summary: string;
  uprightMeaning: string;
  reversedMeaning: string;
  moreInfoUrl: string | null;
  drawDate: string;
  drawnAt: string;
  expiresAt: string;
};

type TarotDeckCard = {
  number: number;
  name: string;
  imageUrl: string;
  summary: string;
  upright: string;
  reversed: string;
  moreInfoUrl: string;
};

type TarotSpreadKey =
  | "single_guidance"
  | "three_past_present_future"
  | "three_situation_action_outcome"
  | "three_you_path_potential"
  | "celtic_cross"
  | "love_relationship"
  | "career_horseshoe"
  | "do_stop_continue"
  | "choice_spread";

type TarotSpreadConfig = {
  key: TarotSpreadKey;
  label: string;
  description: string;
  cardCount: number;
  slotLabels: string[];
  questions: string[];
};

type TarotReadingCard = {
  slot: string;
  card: TarotDeckCard;
  orientation: "upright" | "reversed";
  placed: boolean;
  revealed: boolean;
};

type OracleVoiceOption = {
  name: string;
  lang: string;
};

const MAX_AVATAR_FILE_BYTES = 8_000_000;
const AVATAR_EDITOR_PREVIEW_SIZE = 420;
const AVATAR_EDITOR_EXPORT_SIZE = 1024;
const AVATAR_EDITOR_MAX_SHIFT_RATIO = 0.34;
const AVATAR_EDITOR_MAX_ZOOM = 2.6;

type AvatarStyleChoice = "plain" | "gta5";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const normalizeDegrees = (value: number): number => {
  const normalized = Math.round(value) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

const ORACLE_LANGUAGES = [
  { code: "en-US", label: "English" },
  { code: "sv-SE", label: "Svenska" },
] as const;

const UI_LANGUAGE_STORAGE_KEY = "chkn.uiLanguage";
const DEFAULT_UI_LANGUAGE = "sv-SE";

const normalizeSupportedLanguage = (raw: string | null | undefined): string | null => {
  const value = String(raw || "").trim();
  if (!value) return null;
  const direct = ORACLE_LANGUAGES.find((lang) => lang.code.toLowerCase() === value.toLowerCase());
  if (direct) return direct.code;
  const base = value.toLowerCase().split("-")[0];
  const byBase = ORACLE_LANGUAGES.find((lang) => lang.code.toLowerCase().startsWith(`${base}-`));
  return byBase?.code ?? null;
};

const resolveInitialUiLanguage = (): string => {
  if (typeof window === "undefined") return DEFAULT_UI_LANGUAGE;
  try {
    const stored = normalizeSupportedLanguage(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // ignore localStorage access errors
  }
  return normalizeSupportedLanguage(navigator.language) ?? DEFAULT_UI_LANGUAGE;
};

const isSwedishLocale = (locale: string): boolean => locale.toLowerCase().startsWith("sv");

type BjHandView = {
  userId: string;
  spot: number;
  handIndex: number;
  cards: Array<{ rank: string; suit: string }>;
  total: number;
  status: string;
  bet: number;
  result?: string;
  sideBet?: string | null;
  sideResult?: string | null;
  hidden?: number;
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

const tarotResetLabel = (expiresAtIso: string, locale: string): string => {
  const expiresAt = new Date(expiresAtIso);
  return expiresAt.toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const TAROT_SPREADS: TarotSpreadConfig[] = [
  {
    key: "single_guidance",
    label: "Daily Guidance",
    description: "A single-card intention check for today.",
    cardCount: 1,
    slotLabels: ["Guidance"],
    questions: [
      "What energy do you want to anchor today?",
      "What challenge might test that intention?",
      "What action can you commit to before the day ends?",
    ],
  },
  {
    key: "three_past_present_future",
    label: "Three Card · Past/Present/Future",
    description: "See how your history shapes your present and where momentum points next.",
    cardCount: 3,
    slotLabels: ["Past", "Present", "Future"],
    questions: [
      "What situation are you reading about right now?",
      "What past event still affects this area?",
      "What outcome are you secretly hoping for?",
    ],
  },
  {
    key: "three_situation_action_outcome",
    label: "Three Card · Situation/Action/Outcome",
    description: "Practical direction when you need clear next steps.",
    cardCount: 3,
    slotLabels: ["Situation", "Action", "Outcome"],
    questions: [
      "Describe your current challenge in one sentence.",
      "What have you already tried?",
      "What result would make this reading successful for you?",
    ],
  },
  {
    key: "three_you_path_potential",
    label: "Three Card · You/Path/Potential",
    description: "Self-reflective spread for growth and long-term alignment.",
    cardCount: 3,
    slotLabels: ["You", "Your Path", "Your Potential"],
    questions: [
      "How do you feel about yourself in this season?",
      "What path or direction are you considering?",
      "What part of your potential feels underused?",
    ],
  },
  {
    key: "celtic_cross",
    label: "Celtic Cross (10)",
    description: "Deep dive into your current state, hidden dynamics, and likely outcome.",
    cardCount: 10,
    slotLabels: [
      "Present",
      "Challenge",
      "Subconscious",
      "Foundation",
      "Past",
      "Near Future",
      "You",
      "Environment",
      "Hopes / Fears",
      "Outcome",
    ],
    questions: [
      "What core topic should this Celtic Cross focus on?",
      "What is the biggest pressure in this situation?",
      "What are you not saying out loud about this?",
      "What would an aligned outcome look like for you?",
    ],
  },
  {
    key: "love_relationship",
    label: "Love & Relationship",
    description: "Simple relationship lens: you, partner/other energy, and dynamic.",
    cardCount: 3,
    slotLabels: ["You", "Partner / Other", "Relationship Dynamic"],
    questions: [
      "Who or what relationship is this reading about?",
      "What is your current emotional tone in this connection?",
      "What truth needs to be acknowledged right now?",
    ],
  },
  {
    key: "career_horseshoe",
    label: "Career Horseshoe (7)",
    description: "Career transitions, opportunities, and hidden obstacles.",
    cardCount: 7,
    slotLabels: [
      "Past Influence",
      "Present Situation",
      "Hidden Factors",
      "Obstacle",
      "External Influence",
      "Advice",
      "Likely Outcome",
    ],
    questions: [
      "What career decision are you navigating?",
      "What opportunity feels exciting but uncertain?",
      "What practical result are you aiming for in the next 3 months?",
    ],
  },
  {
    key: "do_stop_continue",
    label: "Do / Stop / Continue",
    description: "Direct action spread with minimal fluff.",
    cardCount: 3,
    slotLabels: ["Do", "Stop", "Continue"],
    questions: [
      "What area of life needs decisive action now?",
      "What habit or behavior might be holding you back?",
      "What is already working that you should protect?",
    ],
  },
  {
    key: "choice_spread",
    label: "Choice Spread (Path A vs B)",
    description: "At crossroads: compare two paths and their potential outcomes.",
    cardCount: 6,
    slotLabels: [
      "Path A · Energy",
      "Path A · Outcome",
      "Path A · Lesson",
      "Path B · Energy",
      "Path B · Outcome",
      "Path B · Lesson",
    ],
    questions: [
      "Name Path A in one short sentence.",
      "Name Path B in one short sentence.",
      "Which fear is making this choice harder?",
      "What would success look like one year from now?",
    ],
  },
];

const TAROT_SPREAD_TRANSLATIONS_SV: Record<string, string> = {
  "Daily Guidance": "Daglig vägledning",
  "A single-card intention check for today.": "En snabb enkortsläggning för dagens intention.",
  Guidance: "Vägledning",
  "What energy do you want to anchor today?": "Vilken energi vill du förankra idag?",
  "What challenge might test that intention?": "Vilken utmaning kan testa den intentionen?",
  "What action can you commit to before the day ends?": "Vilken handling kan du lova innan dagen är slut?",
  "Three Card · Past/Present/Future": "Tre kort · Dåtid/Nutid/Framtid",
  "See how your history shapes your present and where momentum points next.":
    "Se hur din historia formar nuet och vart rörelsen pekar härnäst.",
  Past: "Dåtid",
  Present: "Nutid",
  Future: "Framtid",
  "What situation are you reading about right now?": "Vilken situation läser du om just nu?",
  "What past event still affects this area?": "Vilken tidigare händelse påverkar området fortfarande?",
  "What outcome are you secretly hoping for?": "Vilket utfall hoppas du innerst inne på?",
  "Three Card · Situation/Action/Outcome": "Tre kort · Situation/Handling/Utfall",
  "Practical direction when you need clear next steps.": "Praktisk riktning när du behöver tydliga nästa steg.",
  Situation: "Situation",
  Action: "Handling",
  Outcome: "Utfall",
  "Describe your current challenge in one sentence.": "Beskriv din nuvarande utmaning i en mening.",
  "What have you already tried?": "Vad har du redan provat?",
  "What result would make this reading successful for you?": "Vilket resultat skulle göra läsningen lyckad för dig?",
  "Three Card · You/Path/Potential": "Tre kort · Du/Väg/Potential",
  "Self-reflective spread for growth and long-term alignment.":
    "Självreflekterande läggning för utveckling och långsiktig linjering.",
  You: "Du",
  "Your Path": "Din väg",
  "Your Potential": "Din potential",
  "How do you feel about yourself in this season?": "Hur känner du inför dig själv i den här perioden?",
  "What path or direction are you considering?": "Vilken väg eller riktning överväger du?",
  "What part of your potential feels underused?": "Vilken del av din potential känns underanvänd?",
  "Celtic Cross (10)": "Keltiskt kors (10)",
  "Deep dive into your current state, hidden dynamics, and likely outcome.":
    "Djupdyk i ditt nuläge, dolda dynamiker och troligt utfall.",
  Challenge: "Utmaning",
  Subconscious: "Undermedvetet",
  Foundation: "Grund",
  "Near Future": "Nära framtid",
  Environment: "Miljö",
  "Hopes / Fears": "Hopp / Rädslor",
  "What core topic should this Celtic Cross focus on?":
    "Vilket kärntema ska detta keltiska kors fokusera på?",
  "What is the biggest pressure in this situation?": "Vad är största pressen i situationen?",
  "What are you not saying out loud about this?": "Vad säger du inte högt om det här?",
  "What would an aligned outcome look like for you?": "Hur skulle ett linjerat utfall se ut för dig?",
  "Love & Relationship": "Kärlek och relation",
  "Simple relationship lens: you, partner/other energy, and dynamic.":
    "En enkel relationslins: du, partner/annan energi och dynamik.",
  "Partner / Other": "Partner / Annan",
  "Relationship Dynamic": "Relationsdynamik",
  "Who or what relationship is this reading about?": "Vem eller vilken relation gäller läsningen?",
  "What is your current emotional tone in this connection?":
    "Vilken känsloton har du i den här relationen just nu?",
  "What truth needs to be acknowledged right now?": "Vilken sanning behöver erkännas just nu?",
  "Career Horseshoe (7)": "Karriär-hästsko (7)",
  "Career transitions, opportunities, and hidden obstacles.":
    "Karriärskiften, möjligheter och dolda hinder.",
  "Past Influence": "Tidigare påverkan",
  "Present Situation": "Nuvarande situation",
  "Hidden Factors": "Dolda faktorer",
  Obstacle: "Hinder",
  "External Influence": "Yttre påverkan",
  Advice: "Råd",
  "Likely Outcome": "Troligt utfall",
  "What career decision are you navigating?": "Vilket karriärbeslut navigerar du just nu?",
  "What opportunity feels exciting but uncertain?": "Vilken möjlighet känns spännande men osäker?",
  "What practical result are you aiming for in the next 3 months?":
    "Vilket praktiskt resultat siktar du på de kommande tre månaderna?",
  "Do / Stop / Continue": "Gör / Sluta / Fortsätt",
  "Direct action spread with minimal fluff.": "Handlingsfokuserad läggning utan fluff.",
  Do: "Gör",
  Stop: "Sluta",
  Continue: "Fortsätt",
  "What area of life needs decisive action now?": "Vilket livsområde behöver tydlig handling nu?",
  "What habit or behavior might be holding you back?": "Vilken vana eller vilket beteende kan hålla dig tillbaka?",
  "What is already working that you should protect?": "Vad fungerar redan som du bör skydda?",
  "Choice Spread (Path A vs B)": "Valläggning (Väg A vs B)",
  "At crossroads: compare two paths and their potential outcomes.":
    "Vid vägskäl: jämför två vägar och deras möjliga utfall.",
  "Path A · Energy": "Väg A · Energi",
  "Path A · Outcome": "Väg A · Utfall",
  "Path A · Lesson": "Väg A · Lärdom",
  "Path B · Energy": "Väg B · Energi",
  "Path B · Outcome": "Väg B · Utfall",
  "Path B · Lesson": "Väg B · Lärdom",
  "Name Path A in one short sentence.": "Beskriv Väg A i en kort mening.",
  "Name Path B in one short sentence.": "Beskriv Väg B i en kort mening.",
  "Which fear is making this choice harder?": "Vilken rädsla gör valet svårare?",
  "What would success look like one year from now?": "Hur skulle framgång se ut om ett år?",
};

const ASTRO_SIGN_SV: Record<string, string> = {
  Aries: "Väduren",
  Taurus: "Oxen",
  Gemini: "Tvillingarna",
  Cancer: "Kräftan",
  Leo: "Lejonet",
  Virgo: "Jungfrun",
  Libra: "Vågen",
  Scorpio: "Skorpionen",
  Sagittarius: "Skytten",
  Capricorn: "Stenbocken",
  Aquarius: "Vattumannen",
  Pisces: "Fiskarna",
};

const ASTRO_PLANET_SV: Record<string, string> = {
  Sun: "Solen",
  Moon: "Månen",
  Mercury: "Merkurius",
  Venus: "Venus",
  Mars: "Mars",
  Jupiter: "Jupiter",
  Saturn: "Saturnus",
  Uranus: "Uranus",
  Neptune: "Neptunus",
  Pluto: "Pluto",
  "North Node": "Norra noden",
  Lilith: "Lilith",
  Chiron: "Chiron",
};

const HUMAN_DESIGN_TYPE_SV: Record<string, string> = {
  generator: "Generator",
  "manifesting generator": "Manifesterande generator",
  projector: "Projektor",
  manifestor: "Manifestor",
  reflector: "Reflektor",
};

const HUMAN_DESIGN_STRATEGY_SV: Record<string, string> = {
  "wait to respond": "Vänta på respons",
  "wait to respond, then inform": "Vänta på respons, informera sedan",
  "wait to respond then inform": "Vänta på respons, informera sedan",
  "wait for the invitation": "Vänta på inbjudan",
  "wait for invitation": "Vänta på inbjudan",
  inform: "Informera",
  "wait a lunar cycle": "Vänta en måncykel",
  "wait for a lunar cycle": "Vänta en måncykel",
};

const HUMAN_DESIGN_AUTHORITY_SV: Record<string, string> = {
  "emotional authority": "Emotionell auktoritet",
  "emotional (solar plexus) authority": "Emotionell auktoritet (solarplexus)",
  "sacral authority": "Sakral auktoritet",
  "splenic authority": "Mjältauktoritet",
  "ego authority": "Egoauktoritet",
  "ego projected authority": "Egoauktoritet",
  "self-projected authority": "Självprojicerad auktoritet",
  "mental authority": "Mental auktoritet",
  "environmental authority": "Mental auktoritet",
  "lunar authority": "Lunar auktoritet",
  "no inner authority": "Ingen inre auktoritet",
};

const HUMAN_DESIGN_DEFINITION_SV: Record<string, string> = {
  "single definition": "Enkel definition",
  single: "Enkel definition",
  "split definition": "Delad definition",
  split: "Delad definition",
  "triple split definition": "Trippel-delad definition",
  "triple split": "Trippel-delad definition",
  "quadruple split definition": "Kvadrupel-delad definition",
  "quadruple split": "Kvadrupel-delad definition",
};

const HUMAN_DESIGN_CROSS_SV_EXACT: Record<string, string> = {
  "the right angle cross of explanation": "Det rätvinkliga korset för förklaring",
  "right angle cross of explanation": "Det rätvinkliga korset för förklaring",
};

const HUMAN_DESIGN_CROSS_TERM_SV: Record<string, string> = {
  explanation: "förklaring",
  laws: "lagar",
  planning: "planering",
  eden: "eden",
  service: "tjänst",
  sphinx: "sfinksen",
  rulership: "ledarskap",
  penetration: "genomträngning",
  contagion: "smitta",
  incarnation: "inkarnation",
  consciousness: "medvetande",
  upheaval: "omvälvning",
  tension: "spänning",
  four: "fyra",
  ways: "vägar",
  vessel: "kärlet",
  love: "kärlek",
};

const HUMAN_DESIGN_ROLE_SV: Record<string, string> = {
  investigator: "Utforskare",
  hermit: "Eremit",
  martyr: "Prövare",
  opportunist: "Nätverkare",
  heretic: "Kättare",
  "role model": "Förebild",
};

const HUMAN_DESIGN_NOTSELF_SV: Record<string, string> = {
  frustration: "Frustration",
  anger: "Ilska",
  bitterness: "Bitterhet",
  disappointment: "Besvikelse",
};

const HUMAN_DESIGN_SIGNATURE_SV: Record<string, string> = {
  satisfaction: "Tillfredsställelse",
  peace: "Frid",
  success: "Framgång",
  surprise: "Överraskning",
};

const ZODIAC_ANIMAL_SV: Record<string, string> = {
  Rat: "Råttan",
  Ox: "Oxen",
  Tiger: "Tigern",
  Rabbit: "Kaninen",
  Dragon: "Draken",
  Snake: "Ormen",
  Horse: "Hästen",
  Goat: "Geten",
  Monkey: "Apan",
  Rooster: "Tuppen",
  Dog: "Hunden",
  Pig: "Grisen",
};

const ZODIAC_ELEMENT_SV: Record<string, string> = {
  Wood: "Trä",
  Fire: "Eld",
  Earth: "Jord",
  Metal: "Metall",
  Water: "Vatten",
};

const ZODIAC_YINYANG_SV: Record<string, string> = {
  Yin: "Yin",
  Yang: "Yang",
};

const ZODIAC_TRINE_SV: Record<string, string> = {
  "1st": "1:a",
  "2nd": "2:a",
  "3rd": "3:e",
  "4th": "4:e",
};

const ZODIAC_MEANING_SV: Record<string, string> = {
  Rat: "Råttan är snabb och klarsynt; hos dig kan den visa sig som kvickt problemlösande.",
  Ox: "Oxen är stadig och uthållig; hos dig känns den som tyst styrka och stabilitet.",
  Tiger: "Tigern är modig och passionerad; hos dig blir den till driv och initiativ.",
  Rabbit: "Kaninen är varsam och diplomatisk; hos dig skapar den mjuk närvaro och balans.",
  Dragon: "Draken är magnetisk och visionär; hos dig kan den ge stark närvaro och riktning.",
  Snake: "Ormen är intuitiv och strategisk; hos dig syns den i förmågan att läsa mellan raderna.",
  Horse: "Hästen är fri och framåtriktad; hos dig blir den till rörelse och momentum.",
  Goat: "Geten är kreativ och empatisk; hos dig blir den till mild men tydlig styrka.",
  Monkey: "Apan är lekfull och skarp; hos dig visar den sig som smart anpassningsförmåga.",
  Rooster: "Tuppen är noggrann och stolt; hos dig blir den till klarhet och precision.",
  Dog: "Hunden är lojal och beskyddande; hos dig känns den som trofasthet och omsorg.",
  Pig: "Grisen är generös och jordnära; hos dig blir den till varm och trygg närvaro.",
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
  const [matchMode, setMatchMode] = useState<string>("FIVE_KAMP");
  const [autoReady, setAutoReady] = useState(false);
  const [yatzyCreateStatus, setYatzyCreateStatus] = useState<string | null>(null);
  const [authDebug, setAuthDebug] = useState<{ hasAuthentik: boolean; headers: string[] } | null>(null);
  const [bjRound, setBjRound] = useState<number>(0);
  const [bjHands, setBjHands] = useState<BjHandView[]>([]);
  const [bjDealer, setBjDealer] = useState<BjHandView | null>(null);
  const [bjBet, setBjBet] = useState<number>(10);
  const [bjSpots, setBjSpots] = useState<string>("1");
  const [bjSide, setBjSide] = useState<"NONE" | "UNDER" | "OVER">("NONE");
  const [ninaLine, setNinaLine] = useState<string>("");
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileMissing, setProfileMissing] = useState(true);
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileInfo, setProfileInfo] = useState<ProfilePayload | null>(null);
  const [avatarVersion, setAvatarVersion] = useState<number>(() => Date.now());
  const [avatarUploadBusy, setAvatarUploadBusy] = useState(false);
  const [avatarUploadStatus, setAvatarUploadStatus] = useState<string | null>(null);
  const [avatarUploadError, setAvatarUploadError] = useState<string | null>(null);
  const [avatarDraftDataUrl, setAvatarDraftDataUrl] = useState<string | null>(null);
  const [avatarDraftName, setAvatarDraftName] = useState<string>("");
  const [avatarDraftZoom, setAvatarDraftZoom] = useState<number>(1);
  const [avatarDraftOffsetX, setAvatarDraftOffsetX] = useState<number>(0);
  const [avatarDraftOffsetY, setAvatarDraftOffsetY] = useState<number>(0);
  const [avatarDraftRotation, setAvatarDraftRotation] = useState<number>(0);
  const [avatarUploadStyle, setAvatarUploadStyle] = useState<AvatarStyleChoice>("plain");
  const [insights, setInsights] = useState<ProfileInsights | null>(null);
  const [hdPageInsights, setHdPageInsights] = useState<ProfileInsights | null>(null);
  const [hdPageLoading, setHdPageLoading] = useState(false);
  const [hdPageError, setHdPageError] = useState<string | null>(null);
  const [hdPageProfile, setHdPageProfile] = useState<ProfilePayload | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(true);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [tarotDaily, setTarotDaily] = useState<TarotDailyDraw | null>(null);
  const [tarotStatus, setTarotStatus] = useState<string | null>(null);
  const [tarotLoading, setTarotLoading] = useState(false);
  const [tarotDrawCreated, setTarotDrawCreated] = useState<boolean | null>(null);
  const [tarotDeck, setTarotDeck] = useState<TarotDeckCard[]>([]);
  const [tarotDeckLocale, setTarotDeckLocale] = useState<string>("");
  const [tarotDeckLoading, setTarotDeckLoading] = useState(false);
  const [tarotDeckError, setTarotDeckError] = useState<string | null>(null);
  const [selectedSpreadKey] = useState<TarotSpreadKey>("love_relationship");
  const [oracleAnswers, setOracleAnswers] = useState<string[]>([]);
  const [oracleVoiceTranscript, setOracleVoiceTranscript] = useState("");
  const [oracleMessages, setOracleMessages] = useState<Array<{ role: "oracle" | "user"; text: string }>>([]);
  const [oracleSessionStarted, setOracleSessionStarted] = useState(false);
  const [oracleVoiceEnabled, setOracleVoiceEnabled] = useState(true);
  const [oracleLanguage, setOracleLanguage] = useState<string>(() => resolveInitialUiLanguage());
  const [oracleVoices, setOracleVoices] = useState<OracleVoiceOption[]>([]);
  const [selectedOracleVoice, setSelectedOracleVoice] = useState<string>("");
  const [oracleListening, setOracleListening] = useState(false);
  const [oracleStatus, setOracleStatus] = useState<string | null>(null);
  const [oracleAiLoading, setOracleAiLoading] = useState(false);
  const [oracleQuestionStep, setOracleQuestionStep] = useState(0);
  const [tarotReadingCards, setTarotReadingCards] = useState<TarotReadingCard[]>([]);
  const [tarotDealing, setTarotDealing] = useState(false);
  const [tarotShuffleActive, setTarotShuffleActive] = useState(false);
  const [tarotReadingSummary, setTarotReadingSummary] = useState<string | null>(null);
  const [loveReadingStage, setLoveReadingStage] = useState<
    | "intro"
    | "choice"
    | "preparation"
    | "dealing"
    | "card1"
    | "card2"
    | "card3"
    | "clarify_offer"
    | "clarify_dealing"
    | "clarify_card"
    | "done"
  >("intro");
  const [loveReadingChoice, setLoveReadingChoice] = useState<string>("");
  const [introImageMissing, setIntroImageMissing] = useState(false);
  const [focusedReadingCard, setFocusedReadingCard] = useState<{
    index: number;
    card: TarotReadingCard;
  } | null>(null);
  const [focusedReadingCardFlipped, setFocusedReadingCardFlipped] = useState(false);
  const [modal, setModal] = useState<{
    title: string;
    subtitle?: string;
    body: string;
    actions?: { label: string; href: string }[];
    icon?: React.ReactNode;
    imageUrl?: string;
    imageAlt?: string;
  } | null>(null);
  const [mapLatLng, setMapLatLng] = useState<{ lat: number; lng: number } | null>(null);
  const [placeResults, setPlaceResults] = useState<PlaceResult[]>([]);
  const [placeLoading, setPlaceLoading] = useState(false);
  const [showCoords, setShowCoords] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [isHdOpen, setIsHdOpen] = useState(false);
  const [isHdChartOpen, setIsHdChartOpen] = useState(false);
  const [isAvatarModalOpen, setIsAvatarModalOpen] = useState(false);
  const oracleRecognitionRef = useRef<any>(null);
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);
  const avatarPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const avatarDraftImageRef = useRef<HTMLImageElement | null>(null);
  const userInitial = (profileInfo?.name ?? profileInfo?.username ?? "?")
    .trim()
    .charAt(0)
    .toUpperCase();
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
  const isGamesPage = pathname.startsWith("/games") || pathname.startsWith("/lobby") || pathname.startsWith("/blackjack");
  const isTarotPage = pathname.startsWith("/tarot");
  const ytzyBase = (import.meta.env.VITE_YTZY_URL || "https://ytzy.sputnet.world").trim();
  const profileAvatarApiUrl = useMemo(() => {
    const base = (import.meta.env.VITE_API_URL || "").trim();
    if (!base) return `${window.location.origin}/api/profile/avatar`;
    const clean = base.replace(/\/$/, "");
    return clean.endsWith("/api") ? `${clean}/profile/avatar` : `${clean}/api/profile/avatar`;
  }, []);
  const avatarUrl = useMemo(
    () => `${profileAvatarApiUrl}?v=${encodeURIComponent(String(avatarVersion))}`,
    [avatarVersion, profileAvatarApiUrl]
  );
  const hdPageUserId = isHumanDesignPage
    ? window.location.pathname.replace("/human-design", "").replace(/^\/+/, "")
    : "";
  const [showEditForm, setShowEditForm] = useState(false);
  const isSwedish = useMemo(() => isSwedishLocale(oracleLanguage), [oracleLanguage]);
  const tr = useCallback(
    (sv: string, en: string) => (isSwedish ? sv : en),
    [isSwedish]
  );
  const localizeSignName = useCallback(
    (sign?: string | null) => {
      if (!sign) return "";
      return isSwedish ? ASTRO_SIGN_SV[sign] ?? sign : sign;
    },
    [isSwedish]
  );
  const localizePlanetName = useCallback(
    (planet?: string | null) => {
      if (!planet) return "";
      return isSwedish ? ASTRO_PLANET_SV[planet] ?? planet : planet;
    },
    [isSwedish]
  );
  const normalizeLabel = useCallback(
    (value?: string | null) =>
      String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[\u2010-\u2015]/g, "-")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    []
  );
  const normalizeSpeechLabel = useCallback(
    (value?: string | null) =>
      String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[\u2010-\u2015]/g, "-")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim(),
    []
  );
  const findBestVoiceOption = useCallback(
    (transcript: string, options: string[]): string | null => {
      const normalizedTranscript = normalizeSpeechLabel(transcript);
      if (!normalizedTranscript) return null;
      const transcriptTokens = new Set(normalizedTranscript.split(" ").filter(Boolean));
      let best: { option: string; score: number } | null = null;
      for (const option of options) {
        const normalizedOption = normalizeSpeechLabel(option);
        if (!normalizedOption) continue;
        if (
          normalizedTranscript === normalizedOption ||
          normalizedTranscript.includes(normalizedOption) ||
          normalizedOption.includes(normalizedTranscript)
        ) {
          return option;
        }
        const optionTokens = normalizedOption.split(" ").filter(Boolean);
        if (optionTokens.length === 0) continue;
        const overlap = optionTokens.filter((token) => transcriptTokens.has(token)).length;
        const score = overlap / optionTokens.length;
        if (!best || score > best.score) best = { option, score };
      }
      return best && best.score >= 0.5 ? best.option : null;
    },
    [normalizeSpeechLabel]
  );
  const localizeLookup = useCallback(
    (value: string, dict: Record<string, string>) => {
      const raw = String(value ?? "").trim();
      if (!raw) return "";
      if (dict[raw]) return dict[raw];
      const normalized = normalizeLabel(raw);
      if (!normalized) return "";
      if (dict[normalized]) return dict[normalized];
      const match = Object.entries(dict).find(([candidate]) => normalizeLabel(candidate) === normalized);
      return match?.[1] ?? "";
    },
    [normalizeLabel]
  );
  const localizeDelimited = useCallback(
    (value: string, dict: Record<string, string>) => {
      if (!isSwedish) return value;
      const parts = value
        .split(/[\/,]/)
        .map((part) => part.trim())
        .filter(Boolean);
      if (!parts.length) return value;
      return parts.map((part) => localizeLookup(part, dict) || part).join(" / ");
    },
    [isSwedish, localizeLookup]
  );
  const localizeHumanDesignType = useCallback(
    (value?: string | null) => {
      if (!value) return "";
      return isSwedish ? localizeLookup(value, HUMAN_DESIGN_TYPE_SV) || value : value;
    },
    [isSwedish, localizeLookup]
  );
  const localizeHumanDesignStrategy = useCallback(
    (value?: string | null) => {
      if (!value) return "";
      return isSwedish ? localizeLookup(value, HUMAN_DESIGN_STRATEGY_SV) || value : value;
    },
    [isSwedish, localizeLookup]
  );
  const localizeHumanDesignAuthority = useCallback(
    (value?: string | null) => {
      if (!value) return "";
      return isSwedish ? localizeLookup(value, HUMAN_DESIGN_AUTHORITY_SV) || value : value;
    },
    [isSwedish, localizeLookup]
  );
  const localizeHumanDesignDefinition = useCallback(
    (value?: string | null) => {
      if (!value) return "";
      return isSwedish ? localizeLookup(value, HUMAN_DESIGN_DEFINITION_SV) || value : value;
    },
    [isSwedish, localizeLookup]
  );
  const localizeHumanDesignRole = useCallback(
    (value?: string | null) => {
      if (!value) return "";
      return isSwedish ? localizeDelimited(value, HUMAN_DESIGN_ROLE_SV) : value;
    },
    [isSwedish, localizeDelimited]
  );
  const localizeHumanDesignNotSelf = useCallback(
    (value?: string | null) => {
      if (!value) return "";
      return isSwedish ? localizeDelimited(value, HUMAN_DESIGN_NOTSELF_SV) : value;
    },
    [isSwedish, localizeDelimited]
  );
  const localizeHumanDesignSignature = useCallback(
    (value?: string | null) => {
      if (!value) return "";
      return isSwedish ? localizeDelimited(value, HUMAN_DESIGN_SIGNATURE_SV) : value;
    },
    [isSwedish, localizeDelimited]
  );
  const localizeHumanDesignCross = useCallback(
    (value?: string | null) => {
      if (!value) return "";
      if (!isSwedish) return value;
      const raw = String(value).trim();
      if (!raw) return "";
      const normalized = normalizeLabel(raw);
      if (HUMAN_DESIGN_CROSS_SV_EXACT[normalized]) return HUMAN_DESIGN_CROSS_SV_EXACT[normalized];
      const cleaned = raw.replace(/^the\s+/i, "").trim();
      const match = cleaned.match(/^(right angle|left angle|juxtaposition)\s+cross\s+of\s+(.+)$/i);
      if (!match) return raw;
      const orientationKey = normalizeLabel(match[1]);
      const orientation =
        orientationKey === "right angle"
          ? "Det rätvinkliga"
          : orientationKey === "left angle"
            ? "Det vänstervinkliga"
            : "Juxtapositions";
      const tail = String(match[2] || "")
        .split(/\s+/)
        .map((part) => {
          const key = normalizeLabel(part);
          return HUMAN_DESIGN_CROSS_TERM_SV[key] ?? String(part).toLowerCase();
        })
        .join(" ")
        .trim();
      if (!tail) return raw;
      return orientationKey === "juxtaposition"
        ? `${orientation}korset för ${tail}`
        : `${orientation} korset för ${tail}`;
    },
    [isSwedish, normalizeLabel]
  );
  const localizeZodiacAnimal = useCallback(
    (animal?: string | null) => {
      if (!animal) return "";
      return isSwedish ? localizeLookup(animal, ZODIAC_ANIMAL_SV) || animal : animal;
    },
    [isSwedish, localizeLookup]
  );
  const localizeZodiacElement = useCallback(
    (element?: string | null) => {
      if (!element) return "";
      return isSwedish ? localizeLookup(element, ZODIAC_ELEMENT_SV) || element : element;
    },
    [isSwedish, localizeLookup]
  );
  const localizeZodiacYinYang = useCallback(
    (value?: string | null) => {
      if (!value) return "";
      return isSwedish ? localizeLookup(value, ZODIAC_YINYANG_SV) || value : value;
    },
    [isSwedish, localizeLookup]
  );
  const localizeZodiacTrine = useCallback(
    (value?: string | null) => {
      if (!value) return "";
      return isSwedish ? localizeLookup(value, ZODIAC_TRINE_SV) || value : value;
    },
    [isSwedish, localizeLookup]
  );
  const localizeSpreadText = useCallback(
    (text: string) => (isSwedish ? TAROT_SPREAD_TRANSLATIONS_SV[text] ?? text : text),
    [isSwedish]
  );
  const tarotDailyUrl = useMemo(() => {
    const base = (import.meta.env.VITE_API_URL || "").trim();
    if (!base) return `${window.location.origin}/api/profile/tarot/daily`;
    const clean = base.replace(/\/$/, "");
    return clean.endsWith("/api") ? `${clean}/profile/tarot/daily` : `${clean}/api/profile/tarot/daily`;
  }, []);
  const tarotDeckUrl = useMemo(() => {
    const base = (import.meta.env.VITE_API_URL || "").trim();
    if (!base) return `${window.location.origin}/api/tarot/major-arcana`;
    const clean = base.replace(/\/$/, "");
    return clean.endsWith("/api") ? `${clean}/tarot/major-arcana` : `${clean}/api/tarot/major-arcana`;
  }, []);
  const tarotOracleUrl = useMemo(() => {
    const base = (import.meta.env.VITE_API_URL || "").trim();
    if (!base) return `${window.location.origin}/api/tarot/oracle`;
    const clean = base.replace(/\/$/, "");
    return clean.endsWith("/api") ? `${clean}/tarot/oracle` : `${clean}/api/tarot/oracle`;
  }, []);
  const tarotDailyRequestUrl = useMemo(() => {
    const query = `lang=${encodeURIComponent(oracleLanguage)}`;
    return tarotDailyUrl.includes("?") ? `${tarotDailyUrl}&${query}` : `${tarotDailyUrl}?${query}`;
  }, [oracleLanguage, tarotDailyUrl]);
  const tarotDeckRequestUrl = useMemo(() => {
    const query = `lang=${encodeURIComponent(oracleLanguage)}`;
    return tarotDeckUrl.includes("?") ? `${tarotDeckUrl}&${query}` : `${tarotDeckUrl}?${query}`;
  }, [oracleLanguage, tarotDeckUrl]);
  const selectedSpread = useMemo(
    () => TAROT_SPREADS.find((s) => s.key === selectedSpreadKey) ?? TAROT_SPREADS[0],
    [selectedSpreadKey]
  );
  const localizedSpread = useMemo(
    () => ({
      ...selectedSpread,
      label: localizeSpreadText(selectedSpread.label),
      description: localizeSpreadText(selectedSpread.description),
      slotLabels: selectedSpread.slotLabels.map((slot) => localizeSpreadText(slot)),
      questions: selectedSpread.questions.map((question) => localizeSpreadText(question)),
    }),
    [localizeSpreadText, selectedSpread]
  );
  const oracleProfileContext = useMemo(() => {
    return {
      user: {
        username: profileInfo?.username ?? null,
        name: profileInfo?.name ?? null,
      },
      astrology: {
        sun: insights?.summary_json?.astrology?.sun ?? null,
        moon: insights?.summary_json?.astrology?.moon ?? null,
        ascendant: insights?.summary_json?.astrology?.ascendant ?? null,
      },
      humanDesign: {
        type: insights?.summary_json?.human_design?.type ?? null,
        profile: insights?.summary_json?.human_design?.profile ?? null,
        strategy: insights?.summary_json?.human_design?.strategy ?? null,
        authority: insights?.summary_json?.human_design?.authority ?? null,
        role: insights?.summary_json?.human_design?.role ?? null,
      },
      chineseZodiac: insights?.summary_json?.chinese_zodiac ?? null,
      astrologyRaw: insights?.astrology_json ?? null,
      humanDesignRaw: insights?.human_design_json ?? null,
    };
  }, [insights, profileInfo?.name, profileInfo?.username]);
  const activeLoveCardIndex = useMemo(() => {
    if (loveReadingStage === "card1") return 0;
    if (loveReadingStage === "card2") return 1;
    if (loveReadingStage === "card3") return 2;
    if (loveReadingStage === "clarify_card") return 3;
    return null;
  }, [loveReadingStage]);
  const loveFocusOptions = useMemo(
    () => [
      tr("Nuvarande relation", "Current relationship"),
      tr("Någon ny", "Someone new"),
      tr("Ex / olöst band", "Ex / unresolved bond"),
    ],
    [tr]
  );
  const guidedQuestionOptions = useMemo(
    () => [
      [
        tr("Min nuvarande partner", "My current partner"),
        tr("Någon jag dejtar", "Someone I am dating"),
        tr("Någon ny jag är nyfiken på", "Someone new I am curious about"),
        tr("Ett ex / ett tidigare band", "An ex / a past bond"),
      ],
      [
        tr("Hoppfull och öppen", "Hopeful and open"),
        tr("Osäker och avvaktande", "Unsure and cautious"),
        tr("Sårad men vill förstå", "Hurt but wanting clarity"),
        tr("Redo att gå vidare", "Ready to move on"),
      ],
      [
        tr("Vi behöver tydligare kommunikation", "We need clearer communication"),
        tr("Jag behöver trygghet och konsekvens", "I need safety and consistency"),
        tr("Jag behöver starkare gränser", "I need stronger boundaries"),
        tr("Det är dags att släppa taget", "It is time to let go"),
      ],
    ],
    [tr]
  );
  const activeGuidedQuestion = useMemo(() => {
    if (loveReadingStage !== "preparation") return "";
    const maxIndex = Math.min(localizedSpread.questions.length, guidedQuestionOptions.length) - 1;
    const index = Math.max(0, Math.min(oracleQuestionStep, Math.max(0, maxIndex)));
    return localizedSpread.questions[index] || tr("Välj det alternativ som känns närmast.", "Choose the option that feels closest.");
  }, [guidedQuestionOptions.length, localizedSpread.questions, loveReadingStage, oracleQuestionStep, tr]);
  const activeOracleOptions = useMemo(() => {
    if (loveReadingStage === "choice") return loveFocusOptions;
    if (loveReadingStage !== "preparation") return [] as string[];
    const maxIndex = Math.min(localizedSpread.questions.length, guidedQuestionOptions.length) - 1;
    const index = Math.max(0, Math.min(oracleQuestionStep, Math.max(0, maxIndex)));
    return guidedQuestionOptions[index] ?? [];
  }, [guidedQuestionOptions, localizedSpread.questions.length, loveFocusOptions, loveReadingStage, oracleQuestionStep]);

  useEffect(() => {
    try {
      localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, oracleLanguage);
    } catch {
      // ignore localStorage access errors
    }
  }, [oracleLanguage]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const className = "tarot-cinema-body";
    if (isTarotPage) {
      document.body.classList.add(className);
    } else {
      document.body.classList.remove(className);
    }
    return () => {
      document.body.classList.remove(className);
    };
  }, [isTarotPage]);
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
    icon?: React.ReactNode,
    imageUrl?: string,
    imageAlt?: string
  ) => {
    setModal({ title, body, subtitle, actions, icon, imageUrl, imageAlt });
  };

  const openTarotCardModal = useCallback(() => {
    if (!tarotDaily) return;
    const orientationLabel = tarotDaily.orientation === "upright" ? tr("upprätt", "upright") : tr("omvänt", "reversed");
    const body = [
      `${tr("Sammanfattning", "Summary")}:\n${tarotDaily.summary}`,
      `${tr("Nuvarande orientering", "Current orientation")}: ${orientationLabel}.`,
      `\n${tr("Betydelse upprätt", "Upright meaning")}:\n${tarotDaily.uprightMeaning}`,
      `\n${tr("Betydelse omvänt", "Reversed meaning")}:\n${tarotDaily.reversedMeaning}`,
      tarotDaily.drawnAt
        ? `\n${tr("Drog kortet", "Drawn at")}: ${new Date(tarotDaily.drawnAt).toLocaleString(oracleLanguage, {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    openModal(
      tarotDaily.cardName,
      body,
      `${tr("Dagens dragning", "Daily draw")} · ${tarotDaily.drawDate} · ${orientationLabel}`,
      tarotDaily.moreInfoUrl ? [{ label: tr("Öppna full kortguide", "Open full card guide"), href: tarotDaily.moreInfoUrl }] : undefined,
      "🃏",
      tarotDaily.imageUrl,
      `${tarotDaily.cardName} tarot card`
    );
  }, [openModal, oracleLanguage, tarotDaily, tr]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const synth = window.speechSynthesis;
    const loadVoices = () => {
      const voices = synth
        .getVoices()
        .filter((v) => Boolean(v.name && v.lang))
        .map((v) => ({ name: v.name, lang: v.lang }))
        .sort((a, b) => `${a.lang}-${a.name}`.localeCompare(`${b.lang}-${b.name}`));
      setOracleVoices(voices);
      setSelectedOracleVoice((current) => {
        if (current && voices.some((v) => v.name === current)) return current;
        const preferred =
          voices.find((v) => v.lang.toLowerCase().startsWith(oracleLanguage.toLowerCase().split("-")[0])) ||
          voices[0];
        return preferred?.name ?? "";
      });
    };
    loadVoices();
    synth.onvoiceschanged = loadVoices;
    return () => {
      synth.onvoiceschanged = null;
    };
  }, [oracleLanguage]);

  const speakOracle = useCallback(
    (text: string) => {
      if (!oracleVoiceEnabled) return;
      const synth = window.speechSynthesis;
      if (!synth) return;
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = synth.getVoices();
      const mysticalVoice =
        voices.find((v) => v.name === selectedOracleVoice) ||
        voices.find((v) =>
          /(female|samantha|zira|victoria|karen|moira|serena|joanna|salli|google uk english female)/i.test(
            v.name
          )
        ) ||
        voices.find((v) => v.lang.toLowerCase().startsWith(oracleLanguage.toLowerCase().split("-")[0])) ||
        null;
      if (mysticalVoice) utterance.voice = mysticalVoice;
      utterance.rate = 0.82;
      utterance.pitch = 0.72;
      utterance.lang = oracleLanguage;
      synth.speak(utterance);
    },
    [oracleLanguage, oracleVoiceEnabled, selectedOracleVoice]
  );

  const startOracleListening = useCallback(() => {
    const w = window as unknown as {
      SpeechRecognition?: any;
      webkitSpeechRecognition?: any;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      setOracleStatus(tr("Madame Flood kan inte ta emot röstinmatning i den här webbläsaren.", "Madame Flood cannot hear voice input in this browser."));
      return;
    }
    if (oracleRecognitionRef.current) {
      try {
        oracleRecognitionRef.current.stop();
      } catch {
        // ignore
      }
    }
    const recognition = new Ctor();
    recognition.lang = oracleLanguage;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      setOracleListening(true);
      setOracleStatus(tr("Madame Flood lyssnar...", "Madame Flood is listening..."));
    };
    recognition.onerror = () => {
      setOracleListening(false);
      setOracleStatus(
        tr(
          "Din röst kom inte fram. Försök igen eller välj ett alternativ med knapp.",
          "Your voice did not come through. Try again or pick an option by button."
        )
      );
    };
    recognition.onend = () => {
      setOracleListening(false);
      setOracleStatus(null);
    };
    recognition.onresult = (event: any) => {
      const transcript = String(event?.results?.[0]?.[0]?.transcript || "").trim();
      if (!transcript) return;
      setOracleVoiceTranscript(transcript);
    };
    oracleRecognitionRef.current = recognition;
    recognition.start();
  }, [oracleLanguage, tr]);

  const requestOracleReply = useCallback(
    async (userPrompt: string, seededMessages?: Array<{ role: "oracle" | "user"; text: string }>) => {
      const baseMessages = seededMessages ?? oracleMessages;
      const cardsForContext = tarotReadingCards
        .filter((entry) => entry.revealed)
        .map((entry) => ({
          slot: entry.slot,
          name: entry.card.name,
          orientation: entry.orientation,
          summary: entry.card.summary,
          upright: entry.card.upright,
          reversed: entry.card.reversed,
        }));
      setOracleAiLoading(true);
      setOracleStatus(tr("Madame Flood läser korten...", "Madame Flood is reading the cards..."));
      try {
        const res = await fetch(tarotOracleUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            spreadKey: selectedSpread.key,
            spreadLabel: localizedSpread.label,
            spreadDescription: localizedSpread.description,
            language: oracleLanguage,
            message: userPrompt,
            answers: oracleAnswers,
            cards: cardsForContext,
            profileContext: oracleProfileContext,
            conversation: baseMessages.slice(-14).map((msg) => ({
              role: msg.role === "user" ? "user" : "assistant",
              text: msg.text,
            })),
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok || typeof data.reply !== "string") {
          throw new Error(data?.message || data?.error || "oracle_failed");
        }
        const reply = data.reply.trim();
        setOracleMessages((prev) => [...prev, { role: "oracle", text: reply }]);
        speakOracle(reply);
        return reply;
      } catch {
        const fallback =
          tr(
            "Slöjan skakar. Stanna kvar och tala en gång till så jag kan fortsätta din läsning.",
            "The veil shakes. Stay with me and speak once more so I can continue your reading."
          );
        setOracleMessages((prev) => [...prev, { role: "oracle", text: fallback }]);
        speakOracle(fallback);
        return fallback;
      } finally {
        setOracleAiLoading(false);
        setOracleStatus(null);
      }
    },
    [
      oracleAnswers,
      oracleMessages,
      selectedSpread.key,
      localizedSpread.description,
      localizedSpread.label,
      speakOracle,
      oracleLanguage,
      oracleProfileContext,
      tarotOracleUrl,
      tarotReadingCards,
      tr,
    ]
  );

  const startOracleSession = useCallback(() => {
    setOracleSessionStarted(true);
    setOracleAnswers([]);
    setOracleVoiceTranscript("");
    setOracleQuestionStep(0);
    setTarotReadingCards([]);
    setTarotReadingSummary(null);
    setFocusedReadingCard(null);
    setFocusedReadingCardFlipped(false);
    setTarotShuffleActive(false);
    setTarotDealing(false);
    setLoveReadingChoice("");
    setLoveReadingStage("choice");
    const intro =
      oracleLanguage.startsWith("sv")
        ? "Välkommen in i mörkret. Jag är Madame Flood. Sitt ner vid mitt bord så läser vi ditt hjärta."
        : "Welcome into the dark. I am Madame Flood. Sit at my table and I will read your heart.";
    const seedMessages: Array<{ role: "oracle" | "user"; text: string }> = [{ role: "oracle", text: intro }];
    setOracleMessages(seedMessages);
    speakOracle(intro);
    const focusOptions = isSwedish
      ? '"Nuvarande relation", "Någon ny" eller "Ex / olöst band"'
      : '"Current relationship", "Someone new", or "Ex / unresolved bond"';
    void requestOracleReply(
      tr(
        `Presentera dig i första person som Madame Flood och tala naturligt som en verklig spådam i rummet. Ge en kort personlig intro baserat på sökerens profilkontext. Be sökaren välja ett kärleksfokus: ${focusOptions}. Svara på ${oracleLanguage}.`,
        `Introduce yourself in first person as Madame Flood and speak naturally like a real fortune teller in the room. Give a short personalized intro based on the seeker profile context. Tell the seeker to choose one love-reading focus: ${focusOptions}. Respond in ${oracleLanguage}.`
      ),
      seedMessages
    );
  }, [isSwedish, oracleLanguage, requestOracleReply, speakOracle, tr]);

  const dealLoveReadingCards = useCallback(
    (mode: "initial" | "clarifier") => {
      const requiredCards = mode === "initial" ? 3 : 1;
      if (tarotDeck.length < requiredCards) {
        setOracleStatus(tr("Kortleken är inte redo än.", "Deck is not ready yet."));
        return;
      }
      const used = new Set<number>(
        mode === "clarifier" ? tarotReadingCards.map((entry) => entry.card.number) : []
      );
      const pool = tarotDeck.filter((card) => !used.has(card.number));
      if (pool.length < requiredCards) {
        setOracleStatus(tr("Det finns inte tillräckligt med kort kvar.", "Not enough cards left."));
        return;
      }
      const shuffled = [...pool];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = temp;
      }
      const drawn = shuffled.slice(0, requiredCards);
      const slots =
        mode === "initial"
          ? localizedSpread.slotLabels.slice(0, 3)
          : [tr("Förtydligande kort", "Clarifying Card")];
      const entries: TarotReadingCard[] = drawn.map((card, idx) => ({
        slot: slots[idx] ?? tr(`Kort ${idx + 1}`, `Card ${idx + 1}`),
        card,
        orientation: Math.random() < 0.5 ? "upright" : "reversed",
        placed: false,
        revealed: false,
      }));

      setOracleStatus(null);
      setFocusedReadingCard(null);
      setFocusedReadingCardFlipped(false);
      setTarotShuffleActive(true);
      setTarotDealing(true);
      setLoveReadingStage(mode === "initial" ? "dealing" : "clarify_dealing");
      if (mode === "initial") {
        setTarotReadingCards(entries);
      } else {
        setTarotReadingCards((prev) => [...prev, ...entries]);
      }

      const shuffleDelay = 900;
      const startIndex = mode === "initial" ? 0 : Math.max(0, tarotReadingCards.length);
      window.setTimeout(() => {
        setTarotShuffleActive(false);
        entries.forEach((_, idx) => {
          window.setTimeout(() => {
            setTarotReadingCards((prev) =>
              prev.map((entry, entryIdx) =>
                entryIdx === startIndex + idx ? { ...entry, placed: true } : entry
              )
            );
          }, 320 * idx);
        });
      }, shuffleDelay);

      const doneDelay = shuffleDelay + 320 * entries.length + 350;
      window.setTimeout(() => {
        setTarotDealing(false);
        if (mode === "initial") {
          setLoveReadingStage("card1");
          const line = oracleLanguage.startsWith("sv")
            ? "Kort ett blinkar. Vänd första kortet när du är redo."
            : "Card one is glowing. Turn the first card when you are ready.";
          setOracleMessages((prev) => [...prev, { role: "oracle", text: line }]);
          speakOracle(line);
        } else {
          setLoveReadingStage("clarify_card");
          const line = oracleLanguage.startsWith("sv")
            ? "Förtydligande kortet är lagt. Vänd det nu."
            : "The clarifying card is placed. Turn it now.";
          setOracleMessages((prev) => [...prev, { role: "oracle", text: line }]);
          speakOracle(line);
        }
      }, doneDelay);
    },
    [localizedSpread.slotLabels, oracleLanguage, speakOracle, tarotDeck, tarotReadingCards.length, tr]
  );

  const chooseLoveReadingFocus = useCallback(
    (choice: string) => {
      setLoveReadingChoice(choice);
      setLoveReadingStage("preparation");
      setOracleQuestionStep(0);
      const userLine = oracleLanguage.startsWith("sv")
        ? `Jag väljer fokus: ${choice}`
        : `I choose this focus: ${choice}`;
      const firstQuestion =
        localizedSpread.questions[0] ||
        tr(
          "Välj det alternativ som bäst beskriver vem eller vad läsningen gäller.",
          "Choose the option that best describes who or what the reading is about."
        );
      const oracleLine = tr(
        `Vi börjar med valbara svar så jag kan ställa in läsningen. Första frågan: ${firstQuestion}`,
        `We start with guided options so I can tune the reading. First question: ${firstQuestion}`
      );
      const nextMessages = [
        ...oracleMessages,
        { role: "user" as const, text: userLine },
        { role: "oracle" as const, text: oracleLine },
      ];
      setOracleMessages(nextMessages);
      speakOracle(oracleLine);
    },
    [localizedSpread.questions, oracleLanguage, oracleMessages, speakOracle, tr]
  );

  const chooseGuidedQuestionOption = useCallback(
    (choice: string) => {
      if (loveReadingStage !== "preparation") return;
      const maxIndex = Math.min(localizedSpread.questions.length, guidedQuestionOptions.length) - 1;
      const currentIndex = Math.max(0, Math.min(oracleQuestionStep, Math.max(0, maxIndex)));
      const currentQuestion = localizedSpread.questions[currentIndex] || tr("Förberedelsefråga", "Preparation question");
      const userLine = `${currentQuestion} ${tr("Svar", "Answer")}: ${choice}`;
      const nextAnswers = [...oracleAnswers, `${currentQuestion}: ${choice}`];
      const withUser = [...oracleMessages, { role: "user" as const, text: userLine }];
      setOracleAnswers(nextAnswers);

      const nextIndex = currentIndex + 1;
      if (nextIndex <= maxIndex) {
        const nextQuestion = localizedSpread.questions[nextIndex];
        const oracleLine = tr(
          `Tack. Nästa fråga: ${nextQuestion}`,
          `Thank you. Next question: ${nextQuestion}`
        );
        setOracleQuestionStep(nextIndex);
        setOracleMessages([...withUser, { role: "oracle" as const, text: oracleLine }]);
        speakOracle(oracleLine);
        return;
      }

      setOracleQuestionStep(0);
      setOracleMessages(withUser);
      void requestOracleReply(
        tr(
          `Sökaren valde kärleksfokus "${loveReadingChoice || choice}" och dessa förberedelsesvar: ${nextAnswers.join(
            " | "
          )}. Beskriv ritualen som en filmisk spådamsscen: bordet öppnas, korten blandas och be sökaren hålla en person i åtanke. Avsluta med att bjuda in till dragningen.`,
          `The seeker chose love-reading focus "${loveReadingChoice || choice}" and these preparation answers: ${nextAnswers.join(
            " | "
          )}. Explain the ritual as a cinematic fortune-teller scene: table opens, cards are shuffled, and ask the seeker to hold one person in mind. End by inviting them to begin the draw.`
        ),
        withUser
      ).then(() => {
        dealLoveReadingCards("initial");
      });
    },
    [
      dealLoveReadingCards,
      guidedQuestionOptions.length,
      localizedSpread.questions,
      loveReadingChoice,
      loveReadingStage,
      oracleAnswers,
      oracleMessages,
      oracleQuestionStep,
      requestOracleReply,
      speakOracle,
      tr,
    ]
  );

  useEffect(() => {
    const transcript = oracleVoiceTranscript.trim();
    if (!transcript) return;
    if (!oracleSessionStarted) {
      setOracleVoiceTranscript("");
      return;
    }
    if (activeOracleOptions.length === 0) {
      setOracleStatus(
        tr(
          `Jag hörde "${transcript}", men just nu väntar vi på nästa steg i läsningen.`,
          `I heard "${transcript}", but we are waiting for the next step in the reading right now.`
        )
      );
      setOracleVoiceTranscript("");
      return;
    }
    const matched = findBestVoiceOption(transcript, activeOracleOptions);
    if (!matched) {
      setOracleStatus(
        tr(
          `Jag hörde "${transcript}", men kunde inte matcha det mot alternativen. Prova igen eller tryck på ett alternativ.`,
          `I heard "${transcript}", but could not match it to the options. Try again or tap an option.`
        )
      );
      setOracleVoiceTranscript("");
      return;
    }
    if (loveReadingStage === "choice") {
      chooseLoveReadingFocus(matched);
    } else if (loveReadingStage === "preparation") {
      chooseGuidedQuestionOption(matched);
    }
    setOracleStatus(
      tr(`Jag hörde "${transcript}" och valde: ${matched}.`, `I heard "${transcript}" and selected: ${matched}.`)
    );
    setOracleVoiceTranscript("");
  }, [
    activeOracleOptions,
    chooseGuidedQuestionOption,
    chooseLoveReadingFocus,
    findBestVoiceOption,
    loveReadingStage,
    oracleSessionStarted,
    oracleVoiceTranscript,
    tr,
  ]);

  const offerClarifyingCard = useCallback(
    (allow: boolean) => {
      if (allow) {
        dealLoveReadingCards("clarifier");
        return;
      }
      setLoveReadingStage("done");
      const line = oracleLanguage.startsWith("sv")
        ? "Då stänger vi läggningen här. Tack för ditt förtroende."
        : "Then we close the reading here. Thank you for your trust.";
      setOracleMessages((prev) => [...prev, { role: "oracle", text: line }]);
      speakOracle(line);
    },
    [dealLoveReadingCards, oracleLanguage, speakOracle]
  );

  const openFocusedReadingCard = useCallback(
    (index: number) => {
      const entry = tarotReadingCards[index];
      if (!entry || !entry.placed) return;
      if (activeLoveCardIndex !== null && index !== activeLoveCardIndex) return;
      setFocusedReadingCard({ index, card: entry });
      setFocusedReadingCardFlipped(false);
      window.setTimeout(() => {
        setFocusedReadingCardFlipped(true);
      }, 180);
    },
    [activeLoveCardIndex, tarotReadingCards]
  );

  const closeFocusedReadingCard = useCallback(() => {
    if (!focusedReadingCard) return;
    const { index } = focusedReadingCard;
    const nextCards = tarotReadingCards.map((entry, idx) =>
      idx === index ? { ...entry, revealed: true } : entry
    );
    setTarotReadingCards(nextCards);
    setFocusedReadingCard(null);
    setFocusedReadingCardFlipped(false);
    const revealedEntries = nextCards.filter((entry) => entry.revealed);
    if (revealedEntries.length === 0) return;
    const cardPrompt = revealedEntries
      .map(
        (entry) =>
          `${entry.slot}: ${entry.card.name} (${entry.orientation === "upright" ? tr("upprätt", "upright") : tr("omvänt", "reversed")})\n${tr("Sammanfattning", "Summary")}: ${entry.card.summary}\n${tr("Upprätt", "Upright")}: ${entry.card.upright}\n${tr("Omvänt", "Reversed")}: ${entry.card.reversed}`
      )
      .join("\n\n");
    const focusText = loveReadingChoice || tr("allmän kärleksläsning", "general love reading");
    const revealedLine = tr(
      `Jag avslöjade ${focusedReadingCard.card.card.name} i ${focusedReadingCard.card.slot}.`,
      `I revealed ${focusedReadingCard.card.card.name} in ${focusedReadingCard.card.slot}.`
    );
    const seeded = [...oracleMessages, { role: "user" as const, text: revealedLine }];
    if (loveReadingStage === "card1") {
      setLoveReadingStage("card2");
      void requestOracleReply(
        tr(
          `${revealedLine}\nFokus: ${focusText}\nTolka kort 1 i en kärleksläggning och be sedan sökaren avslöja kort 2.\n\nKort:\n${cardPrompt}`,
          `${revealedLine}\nFocus: ${focusText}\nInterpret card 1 for a love reading and then ask the seeker to reveal card 2.\n\nCards:\n${cardPrompt}`
        ),
        seeded
      ).then((reply) => {
        if (reply) setTarotReadingSummary(reply);
      });
      return;
    }
    if (loveReadingStage === "card2") {
      setLoveReadingStage("card3");
      void requestOracleReply(
        tr(
          `${revealedLine}\nFokus: ${focusText}\nTolka kort 2 och koppla det till kort 1, bjud sedan in sökaren att avslöja kort 3.\n\nKort:\n${cardPrompt}`,
          `${revealedLine}\nFocus: ${focusText}\nInterpret card 2 and connect it to card 1, then invite the seeker to reveal card 3.\n\nCards:\n${cardPrompt}`
        ),
        seeded
      ).then((reply) => {
        if (reply) setTarotReadingSummary(reply);
      });
      return;
    }
    if (loveReadingStage === "card3") {
      setLoveReadingStage("clarify_offer");
      void requestOracleReply(
        tr(
          `${revealedLine}\nFokus: ${focusText}\nSammanfatta nu alla tre kärlekskorten med praktiska insikter och fråga om sökaren vill ha ett förtydligande kort.\n\nKort:\n${cardPrompt}`,
          `${revealedLine}\nFocus: ${focusText}\nNow summarize all three love cards with practical insight and ask if the seeker wants one clarifying card.\n\nCards:\n${cardPrompt}`
        ),
        seeded
      ).then((reply) => {
        if (reply) setTarotReadingSummary(reply);
      });
      return;
    }
    if (loveReadingStage === "clarify_card") {
      setLoveReadingStage("done");
      void requestOracleReply(
        tr(
          `${revealedLine}\nFokus: ${focusText}\nDet här är förtydligandekortet. Ge en slutlig integrerad kärleksläsning med alla kort.\n\nKort:\n${cardPrompt}`,
          `${revealedLine}\nFocus: ${focusText}\nThis is the clarifying card. Give a final integrated love reading using all cards.\n\nCards:\n${cardPrompt}`
        ),
        seeded
      ).then((reply) => {
        if (reply) setTarotReadingSummary(reply);
      });
      return;
    }
    void requestOracleReply(
      tr(
        `${revealedLine}\nFortsätt tolkningen utifrån de kort som redan är avslöjade:\n\n${cardPrompt}`,
        `${revealedLine}\nContinue the oracle interpretation based on currently revealed cards:\n\n${cardPrompt}`
      ),
      seeded
    ).then((reply) => {
      if (reply) setTarotReadingSummary(reply);
    });
  }, [focusedReadingCard, loveReadingChoice, loveReadingStage, oracleMessages, requestOracleReply, tarotReadingCards, tr]);

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
      return tr(
        "Så beräknas det: vi använder födelsedatum, tid och plats för att räkna planetpositioner i den tropiska zodiaken och placerar dem i Placidus-hus. Ascendenten är tecknet som steg i öster vid födelsen.",
        "How it’s calculated: we use your birth date, time, and location to compute planetary positions in the tropical zodiac, then place them into Placidus houses. The Ascendant is the zodiac sign rising on the eastern horizon at the moment you were born."
      );
    }
    if (lower.includes("human design") || ["energy type", "strategy", "authority", "profile"].includes(lower)) {
      return tr(
        "Så beräknas det: Human Design använder astronomiska positioner vid födelsen (och cirka 88 dagar före födelsen för design-charten). Vi beräknar gates, center, typ, profil och auktoritet utifrån dessa.",
        "How it’s calculated: Human Design uses astronomical positions at birth (and ~88 days before birth for the design chart). We compute gates, centers, type, profile, and authority from those positions."
      );
    }
    if (lower.includes("zodiac") || ["year animal", "yin/yang", "element"].includes(lower)) {
      return tr(
        "Så beräknas det: den kinesiska zodiaken bygger på ditt födelseår i en 12-årscykel, med fast yin/yang-polaritet och element enligt traditionellt system.",
        "How it’s calculated: the Chinese zodiac is based on your birth year in a 12‑year cycle, with fixed Yin/Yang polarity and element determined by the traditional system."
      );
    }
    if (lower.includes("account")) {
      return tr(
        "Så beräknas det: kontodata kommer från dina angivna värden i profilen. Kontrollera i inställningarna att stad och tid är korrekta, eftersom beräkningarna är beroende av dem.",
        "How it’s calculated: account data comes from your inputed values in your user profile, check in the settings to view, verify or change your variables, it is important with correct city and time, all calculations depend heavliy on that."
      );
    }
    return tr(
      "Så beräknas det: denna insikt härleds från den födelsedata du angett (datum, tid och plats) och relevanta regler för respektive system.",
      "How it’s calculated: this insight is derived from the profile data you provided at birth (date, time, and place) and the relevant calculation rules for this system."
    );
  };

  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  useEffect(() => {
    if (!isAvatarModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsAvatarModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isAvatarModalOpen]);

  useEffect(() => {
    if (!focusedReadingCard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFocusedReadingCard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeFocusedReadingCard, focusedReadingCard]);

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

  const planetMeaningSv: Record<string, string> = {
    Sun: "Solen är din inre eld - identitet, riktning och rollen du växer in i över tid.",
    Moon: "Månen är ditt inre tidvatten - känslor, behov och det som ger känslomässig trygghet.",
    Mercury: "Merkurius är din mentala röst - hur du lär dig, tänker och översätter verkligheten.",
    Venus: "Venus är din magnetism - kärlek, värderingar och skönheten du dras mot.",
    Mars: "Mars är din gnista - driv, begär och sättet du tar dig framåt.",
    Jupiter: "Jupiter är din horisont - utveckling, tillit och meningen du söker.",
    Saturn: "Saturnus är din ryggrad - disciplin, gränser och långsiktiga lärdomar.",
    Uranus: "Uranus är din blixt - förändring, frihet och originalitet.",
    Neptune: "Neptunus är ditt drömhav - intuition, fantasi och ideal.",
    Pluto: "Pluto är ditt underjordiska djup - kraft, skugga och transformation.",
    "North Node": "Norra noden är din kompass - riktningen för utveckling och livstema.",
    Lilith: "Lilith är din otämjda sanning - rå instinkt och modigt självuttryck.",
    Chiron: "Chiron är din känsliga kant - såret som kan bli visdom.",
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

  const signMeaningSv: Record<string, string> = {
    Aries: "Väduren bär en gnista: modig, direkt och banbrytande.",
    Taurus: "Oxen är den långsamma floden: stadig, jordad och lojal.",
    Gemini: "Tvillingarna är snabbtänkta som vind: nyfikna, rörliga och kommunikativa.",
    Cancer: "Kräftan är härden: omhändertagande, känslig och beskyddande.",
    Leo: "Lejonet är en varm sol: uttrycksfullt, stolt och strålande.",
    Virgo: "Jungfrun är hantverket: precis, analytisk och förbättringsinriktad.",
    Libra: "Vågen är balanspunkten: relationsorienterad och rättvis.",
    Scorpio: "Skorpionen är djup och alkemi: intensiv, privat och transformerande.",
    Sagittarius: "Skytten är den öppna vägen: äventyrlig och frihetssökande.",
    Capricorn: "Stenbocken är bergsstigen: disciplinerad och uthållig.",
    Aquarius: "Vattumannen är framtidens puls: originell och visionär.",
    Pisces: "Fiskarna är tidvatten och dröm: intuitiva, empatiska och fantasifulla.",
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

  const houseNamesSv: Record<number, string> = {
    1: "1:a huset",
    2: "2:a huset",
    3: "3:e huset",
    4: "4:e huset",
    5: "5:e huset",
    6: "6:e huset",
    7: "7:e huset",
    8: "8:e huset",
    9: "9:e huset",
    10: "10:e huset",
    11: "11:e huset",
    12: "12:e huset",
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

  const signToneSv: Record<string, string> = {
    Aries: "agera snabbt, leda med mod och föredra rak kommunikation.",
    Taurus: "röra sig stadigt, värna trygghet och bygga något som håller länge.",
    Gemini: "tänka snabbt, prata öppet och trivas med variation.",
    Cancer: "känna djupt, skydda det som är viktigt och söka emotionell trygghet.",
    Leo: "uttrycka sig modigt, synas naturligt och leda med hjärtat.",
    Virgo: "analysera detaljer, förbättra system och värdera precision.",
    Libra: "söka balans, knyta band genom relationer och stå för rättvisa.",
    Scorpio: "gå på djupet, förvandlas genom intensitet och skydda det privata.",
    Sagittarius: "utforska fritt, lära genom erfarenhet och lita på optimism.",
    Capricorn: "bygga tålmodigt, hålla fast vid mål och respektera struktur.",
    Aquarius: "förnya, tänka framåt och värdera självständighet.",
    Pisces: "lita på intuitionen, känna in andra och väva samman fantasi med känsla.",
  };

  const signGiftSv: Record<string, string> = {
    Aries: "ta initiativ när andra tvekar och ge rörelse åt stillastående lägen.",
    Taurus: "bygga stabilitet som håller även när tempot runt dig skiftar.",
    Gemini: "öppna samtal, skapa broar mellan perspektiv och göra det komplexa begripligt.",
    Cancer: "skapa emotionell trygghet och påminna andra om vad som verkligen betyder något.",
    Leo: "ge mod, värme och hjärta till människor och projekt omkring dig.",
    Virgo: "förfina detaljer så att helheten blir både vacker och fungerande.",
    Libra: "hitta rätt ton i relationer och förvandla friktion till samspel.",
    Scorpio: "gå till kärnan och förvandla kriser till inre styrka.",
    Sagittarius: "vidga horisonter och tända framtidstro i tider av osäkerhet.",
    Capricorn: "hålla riktning över tid och skapa resultat som kan bäras länge.",
    Aquarius: "tänka nytt, bryta mönster och visa vägar ingen annan såg.",
    Pisces: "läka, mjuka upp och ge mening åt sådant som annars känns splittrat.",
  };

  const planetGiftSv: Record<string, string> = {
    Sun: "du lyser klarast när du vågar vara fullt synlig i din egen riktning.",
    Moon: "du läker genom att ära dina känslor och skapa rum för det mjuka.",
    Mercury: "du skapar klarhet genom ord, mönster och skarpa frågor.",
    Venus: "du magnetiserar rätt människor när dina värderingar får styra.",
    Mars: "du flyttar berg när ditt driv får ett tydligt mål.",
    Jupiter: "du växer snabbast när du väljer mening före prestation.",
    Saturn: "du blir stark genom tålamod, struktur och långsiktig disciplin.",
    Uranus: "du frigör potential genom att våga göra annorlunda.",
    Neptune: "du öppnar intuition och kreativitet när du lyssnar inåt.",
    Pluto: "du förnyar livet genom att släppa det som inte längre är sant.",
    "North Node": "du mognar när du följer riktningen som känns utvecklande, inte bara bekväm.",
    Lilith: "du återtar kraft när du vägrar förminska din sanning.",
    Chiron: "du blir vägledare när du gör erfaren smärta till visdom.",
  };

  const planetShadowSv: Record<string, string> = {
    Sun: "att söka bekräftelse utifrån i stället för att stå i ditt eget centrum.",
    Moon: "att bära andras känslor så länge att dina egna behov tystnar.",
    Mercury: "att övertänka tills känslan inte längre får plats.",
    Venus: "att kompromissa bort värdegrunden för att behålla harmoni.",
    Mars: "att pressa fram handling innan riktningen har landat.",
    Jupiter: "att lova mer än du faktiskt har energi att bära.",
    Saturn: "att bli för hård mot dig själv och kalla det ansvar.",
    Uranus: "att bryta mönster så snabbt att förankringen tappas.",
    Neptune: "att drömma stort utan att samtidigt hålla tydliga gränser.",
    Pluto: "att hålla fast i kontroll när livet vill att du ska släppa taget.",
    "North Node": "att välja det välbekanta av rädsla för nästa steg.",
    Lilith: "att gå i motstånd så hårt att sårbarheten göms.",
    Chiron: "att tro att läkningen måste vara perfekt innan du får börja dela.",
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

  const houseMeaningSv: Record<number, string> = {
    1: "1:a huset handlar om identitet, närvaro och första intryck.",
    2: "2:a huset handlar om värderingar, trygghet och resurser.",
    3: "3:e huset handlar om kommunikation, lärande och vardag.",
    4: "4:e huset handlar om hem, rötter och inre trygghet.",
    5: "5:e huset handlar om kreativitet, kärlek och lek.",
    6: "6:e huset handlar om arbete, hälsa och rutiner.",
    7: "7:e huset handlar om partnerskap och nära relationer.",
    8: "8:e huset handlar om transformation, intimitet och djup.",
    9: "9:e huset handlar om mening, filosofi och resor.",
    10: "10:e huset handlar om karriär, status och ambition.",
    11: "11:e huset handlar om gemenskap, vänner och vision.",
    12: "12:e huset handlar om undermedvetna mönster och återhämtning.",
  };

  const houseDetailSv: Record<number, string> = {
    1: "din identitet, personliga stil och hur andra uppfattar dig.",
    2: "pengar, ägodelar, självvärde och vad som känns tryggt.",
    3: "kommunikation, inlärningsstil, syskon och dagliga rörelser.",
    4: "hem, familj, rötter och emotionell grund.",
    5: "kreativitet, romantik, glädje och självuttryck.",
    6: "arbetsvanor, hälsa, tjänande och vardagsrutiner.",
    7: "partnerskap, intimitet och hur du gör commitment.",
    8: "transformation, sårbarhet, delade resurser och återfödelse.",
    9: "tro, utbildning, resor och övergripande mening.",
    10: "karriär, rykte och långsiktig ambition.",
    11: "gemenskap, vänskap och framtidsvision.",
    12: "undermedvetna mönster, ensamhet och andlig återhämtning.",
  };

  const houseLabel = (house?: number | null) => {
    if (!house) return isSwedish ? "hus" : "house";
    return isSwedish
      ? houseNamesSv[house] ?? `hus ${house}`
      : houseNames[house] ?? `house ${house}`;
  };

  const houseMeaningText = (house?: number | null) => {
    if (!house) return isSwedish ? "Det här huset beskriver ett livsområde." : "This house describes a life area.";
    return isSwedish
      ? houseMeaningSv[house] ?? "Det här huset beskriver ett livsområde."
      : houseMeaning[house] ?? "This house describes a life area.";
  };

  const houseDetailText = (house?: number | null) => {
    if (!house) return isSwedish ? "ett nyckelområde i livet." : "a key life area.";
    return isSwedish
      ? houseDetailSv[house] ?? "ett nyckelområde i livet."
      : houseDetail[house] ?? "a key life area.";
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
  const humanDesignTypeDetailSv: Record<string, string> = {
    Generator:
      "Du är byggd för uthållig energi och mästerskap. När något verkligen känns rätt i kroppen blir din kraft både stark och stabil över tid.",
    "Manifesting Generator":
      "Du är snabb, mångsidig och lär genom rörelse. Din väg är ofta att prova, justera och hitta smartare vägar i farten.",
    Projector:
      "Du är här för att se mönster och vägleda med precision. Din styrka växer när du blir sedd och inbjuden till rätt sammanhang.",
    Manifestor:
      "Du är initierande energi. Du öppnar dörrar och startar rörelser, och får bäst flyt när du informerar innan du agerar.",
    Reflector:
      "Du speglar miljön omkring dig. Rätt plats och människor ger klarhet, och din närvaro visar ofta vad som är sant i gruppen.",
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
  const humanDesignAuthorityDetailSv: Record<string, string> = {
    "Emotional Authority":
      "Din klarhet kommer i vågor. Vänta tills känslotoppen och känslodalen lagt sig innan du fattar större beslut.",
    "Sacral Authority":
      "Din kropp svarar direkt med ja/nej. Lita på den omedelbara responsen innan huvudet börjar argumentera.",
    "Splenic Authority":
      "Din intuition är snabb och stillsam. När den viskar i stunden, lita på signalen.",
    "Ego Authority":
      "Din vilja är kompass. Rätt beslut känns som något du verkligen vill och kan stå för fullt ut.",
    "Self‑Projected Authority":
      "Klarhet kommer när du hör dig själv tala. Din riktning blir tydlig när du uttrycker den högt.",
    "Mental Authority":
      "Du får tydlighet i rätt miljö och i samtal med rätt personer. Låt beslut mogna genom dialog.",
    "Lunar Authority":
      "Tid är nyckeln. Ge större beslut en hel måncykel så blir det tydligt vad som är rätt för dig.",
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
  const humanDesignStrategyDetailSv: Record<string, string> = {
    "Wait to Respond":
      "Låt livet komma till dig först och svara sedan från kroppen. Att pressa fram initiativ skapar ofta motstånd.",
    "Wait to Respond, then Inform":
      "Svara först, informera sedan berörda. Det skapar fart med mindre friktion i relationer.",
    "Wait for the Invitation":
      "Vänta på genuin inbjudan i viktiga områden. Rätt inbjudan sparar energi och öppnar rätt dörrar.",
    Inform:
      "Din rörelse blir tydligare när du informerar innan handling. Då minskar missförstånd och motstånd.",
    "Wait a Lunar Cycle":
      "Ge beslut tid. När du följer en måncykel blir skillnaden mellan impuls och klarhet tydligare.",
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
  const humanDesignProfileDetailSv: Record<string, string> = {
    "1/3": "Utforskare/Prövare: du lär genom att förstå grunden och sedan testa i verkligheten.",
    "1/4": "Utforskare/Nätverkare: du bygger stabil kunskap och delar den genom relationer.",
    "2/4": "Eremit/Nätverkare: du behöver egen tid för att vässa dina gåvor, och blommar i rätt nätverk.",
    "2/5": "Eremit/Kättare: andra ser lösningar i dig, och tydliga gränser hjälper dig välja rätt uppdrag.",
    "3/5": "Prövare/Kättare: du lär genom försök, justering och praktiska lärdomar.",
    "3/6": "Prövare/Förebild: tidiga experiment blir senare en levd visdom.",
    "4/6": "Nätverkare/Förebild: relationer öppnar vägar och mognar till ledarskap över tid.",
    "4/1": "Nätverkare/Utforskare: en stabil kärna med påverkan genom gemenskap.",
    "5/1": "Kättare/Utforskare: du är en praktisk problemlösare med faktabaserad tyngd.",
    "5/2": "Kättare/Eremit: projiceringar från andra kräver tydlighet och gränser.",
    "6/2": "Förebild/Eremit: du integrerar i lugn och kliver sedan fram som vägledare.",
    "6/3": "Förebild/Prövare: din auktoritet växer genom levd erfarenhet.",
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
  const humanDesignProfileExamplesSv: Record<string, string> = {
    "1/3": "Exempel: du fördjupar dig först och testar sedan vad som faktiskt håller.",
    "1/4": "Exempel: du bygger en trygg grund och möjligheter kommer via nätverket.",
    "2/4": "Exempel: du behöver egen tid för skärpa, och delar sedan gåvan i rätt sammanhang.",
    "2/5": "Exempel: andra ber dig lösa saker, och du behöver välja dina ja med omsorg.",
    "3/5": "Exempel: du lär snabbt genom att prova, missa, justera och förbättra.",
    "3/6": "Exempel: tidig fas är experiment, senare fas blir mentorering.",
    "4/6": "Exempel: relationer öppnar dörrar och din roll blir tydligare med åren.",
    "4/1": "Exempel: du påverkar genom nätverk men står stadigt i din egen kärna.",
    "5/1": "Exempel: du får förtroende för svåra problem när din research är solid.",
    "5/2": "Exempel: du blir ofta tillfrågad om hjälp och mår bäst med tydliga ramar.",
    "6/2": "Exempel: du backar för att integrera och återkommer med klar vägledning.",
    "6/3": "Exempel: din visdom byggs av verkliga erfarenheter, inte teorier.",
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
  const humanDesignExamplesSv: Record<string, string> = {
    Projector:
      "Exempel: du kan briljera som strateg, coach eller vägledare där din blick för system gör stor skillnad.",
    Generator:
      "Exempel: när ett projekt känns rätt kan du bygga djup skicklighet och hållbar kvalitet.",
    "Manifesting Generator":
      "Exempel: du startar, hittar snabbare vägar och pivoterar naturligt utan att tappa riktning.",
    Manifestor:
      "Exempel: du initierar nya spår och släpper sedan fram andra när rörelsen är igång.",
    Reflector:
      "Exempel: du känner snabbt av stämningen i ett rum och kan visa gruppen vad som behöver justeras.",
  };

  const buildHumanDesignNarrative = () => {
    const type = insights?.summary_json?.human_design?.type ?? "";
    const strategy = insights?.summary_json?.human_design?.strategy ?? "";
    const authority = insights?.summary_json?.human_design?.authority ?? "";
    const profile = insights?.summary_json?.human_design?.profile ?? "";
    const role = insights?.summary_json?.human_design?.role ?? "";
    const definition = insights?.human_design_json?.definition ?? "";
    const typeLabel = localizeHumanDesignType(type);
    const strategyLabel = localizeHumanDesignStrategy(strategy);
    const authorityLabel = localizeHumanDesignAuthority(authority);
    const roleLabel = localizeHumanDesignRole(role);
    const definitionLabel = localizeHumanDesignDefinition(definition);

    if (isSwedish) {
      return [
        type ? `Din energityp är ${typeLabel || type}.` : "",
        strategy ? `Din strategi är ${strategyLabel || strategy}.` : "",
        authority ? `Din auktoritet är ${authorityLabel || authority}.` : "",
        profile ? `Din profil är ${profile}${roleLabel ? ` (${roleLabel})` : role ? ` (${role})` : ""}.` : "",
        definition ? `Din definition är ${definitionLabel || definition}.` : "",
        "Det här visar hur din energi fungerar i beslut, relationer och timing.",
      ]
        .filter(Boolean)
        .join(" ");
    }

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
    ctx.fillText(isSwedish ? "Hög" : "High", left, top - 8 * dpr);
    ctx.fillText(isSwedish ? "Neutral" : "Neutral", left, midY);
    ctx.fillText(isSwedish ? "Låg" : "Low", left, bottom + 8 * dpr);

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
  }, [isSwedish]);

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
  const hdTypeLabel = hdType !== "–" ? localizeHumanDesignType(hdType) : "–";
  const hdStrategyLabel = hdStrategy !== "–" ? localizeHumanDesignStrategy(hdStrategy) : "–";
  const hdAuthorityLabel = hdAuthority !== "–" ? localizeHumanDesignAuthority(hdAuthority) : "–";
  const hdRoleLabel = hdRole ? localizeHumanDesignRole(hdRole) : "";
  const hdDefinitionLabel = hdDefinition !== "–" ? localizeHumanDesignDefinition(hdDefinition) : "–";
  const hdProfileLabel =
    hdProfile !== "–" ? `${hdProfile}${hdRoleLabel ? ` (${hdRoleLabel})` : ""}` : "–";
  const hdTitleBits = [hdTypeLabel, hdAuthorityLabel, hdProfileLabel, hdDefinitionLabel].filter(
    (value) => value && value !== "–"
  );
  const hdDeepDiveTitle = hdTitleBits.length
    ? tr("Riktigt nördig Deep Dive", "Deep nerdy dive") + ` (${hdTitleBits.join(" • ")})`
    : tr("Riktigt nördig Deep Dive", "Deep nerdy dive");
  const isEmotionalAuthority = hdAuthority.toLowerCase().includes("emotional");
  const isSplitDefinition = hdDefinition.toLowerCase().includes("split");
  const profileDetail =
    hdProfile !== "–"
      ? (isSwedish ? humanDesignProfileDetailSv[hdProfile] : humanDesignProfileDetail[hdProfile]) ?? ""
      : "";
  const profileExample =
    hdProfile !== "–"
      ? (isSwedish ? humanDesignProfileExamplesSv[hdProfile] : humanDesignProfileExamples[hdProfile]) ?? ""
      : "";
  const strategyDetail =
    hdStrategy !== "–"
      ? (isSwedish ? humanDesignStrategyDetailSv[hdStrategy] : humanDesignStrategyDetail[hdStrategy]) ?? ""
      : "";
  const authorityDetail =
    hdAuthority !== "–"
      ? (isSwedish ? humanDesignAuthorityDetailSv[hdAuthority] : humanDesignAuthorityDetail[hdAuthority]) ?? ""
      : "";
  const typeSignature = hdType !== "–" ? humanDesignTypeSignature[hdType] ?? "" : "";
  const typeNotSelf = hdType !== "–" ? humanDesignTypeNotSelf[hdType] ?? "" : "";
  const typeSignatureLabel = typeSignature ? localizeHumanDesignSignature(typeSignature) : "";
  const typeNotSelfLabel = typeNotSelf ? localizeHumanDesignNotSelf(typeNotSelf) : "";
  const hdIncarnationRaw =
    hdInsights?.human_design_json?.incarnationCross?.fullName ||
    hdInsights?.human_design_json?.incarnationCross?.name ||
    "–";
  const hdIncarnation =
    hdIncarnationRaw !== "–" ? localizeHumanDesignCross(hdIncarnationRaw) || hdIncarnationRaw : "–";
  const hdProfileSource = isHumanDesignPage ? hdPageProfile : profileInfo;
  const hdEmail = hdProfileSource?.email ?? "";
  const superReportInsights = isHumanDesignPage ? hdPageInsights ?? insights : insights;
  const superReportProfile = isHumanDesignPage ? hdPageProfile ?? profileInfo : profileInfo;

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
    const hdJson = hdInsights?.human_design_json ?? {};
    const gates = hdJson?.gates ?? hdJson?.chart?.gates ?? {};
    const personalityRaw = gates.personality ?? gates.personalityGates ?? hdJson?.personalityGates ?? {};
    const designRaw = gates.design ?? gates.designGates ?? hdJson?.designGates ?? {};
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
    const normalizePlanetKey = (value: unknown): string => {
      const raw = String(value ?? "")
        .trim()
        .replace(/[\s_-]+/g, "")
        .toLowerCase();
      if (!raw) return "";
      if (raw === "northnode" || raw === "north") return "northNode";
      if (raw === "southnode" || raw === "south") return "southNode";
      return raw;
    };
    const parseGateLine = (item: unknown): { gate: number; line: number | null } | null => {
      if (item === null || item === undefined) return null;
      if (typeof item === "number") {
        if (!Number.isFinite(item)) return null;
        const gate = Math.trunc(item);
        const frac = Math.round(Math.abs(item - gate) * 10);
        return { gate, line: frac >= 1 && frac <= 6 ? frac : null };
      }
      if (typeof item === "string") {
        const raw = item.trim();
        if (!raw) return null;
        const match = raw.match(/^(\d{1,2})(?:[.,](\d))?$/);
        if (match) {
          const gate = Number(match[1]);
          const line = match[2] ? Number(match[2]) : null;
          return Number.isFinite(gate) ? { gate, line: line && line >= 1 && line <= 6 ? line : null } : null;
        }
        const numeric = Number(raw);
        if (!Number.isFinite(numeric)) return null;
        const gate = Math.trunc(numeric);
        const frac = Math.round(Math.abs(numeric - gate) * 10);
        return { gate, line: frac >= 1 && frac <= 6 ? frac : null };
      }
      if (Array.isArray(item)) {
        const gate = Number(item[0]);
        if (!Number.isFinite(gate)) return null;
        const line = Number(item[1]);
        return { gate, line: Number.isFinite(line) && line >= 1 && line <= 6 ? line : null };
      }
      if (typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (obj.gate !== undefined || obj.line !== undefined) {
          const gate = Number(obj.gate);
          if (!Number.isFinite(gate)) return null;
          const line = Number(obj.line);
          return { gate, line: Number.isFinite(line) && line >= 1 && line <= 6 ? line : null };
        }
        if (obj.value !== undefined) return parseGateLine(obj.value);
        if (obj.number !== undefined) return parseGateLine(obj.number);
      }
      return null;
    };
    const toGateEntry = (source: unknown, type: "P" | "D") => {
      const entries: Array<{ gate: number; line: number; planet: string; type: "P" | "D" }> = [];
      const push = (planet: string, item: any) => {
        const parsed = parseGateLine(item);
        if (!parsed) return;
        entries.push({
          gate: parsed.gate,
          line: parsed.line ?? 0,
          planet: normalizePlanetKey(planet) || planet,
          type,
        });
      };
      if (Array.isArray(source)) {
        source.forEach((item, idx) => {
          const itemObj = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
          const planet = normalizePlanetKey(itemObj.planet || itemObj.name || planetOrder[idx] || "");
          push(planet, item);
        });
        return entries;
      }
      if (source && typeof source === "object") {
        const sourceObj = source as Record<string, any>;
        const seen = new Set<string>();
        planetOrder.forEach((planet) => {
          const direct = sourceObj[planet];
          if (direct) {
            push(planet, direct);
            seen.add(planet);
            return;
          }
          const aliased = Object.keys(sourceObj).find(
            (key) => normalizePlanetKey(key) === normalizePlanetKey(planet)
          );
          if (aliased) {
            push(planet, sourceObj[aliased]);
            seen.add(aliased);
          }
        });
        Object.entries(sourceObj).forEach(([planet, item]) => {
          if (seen.has(planet)) return;
          push(planet, item);
        });
      }
      return entries;
    };

    const personalityGates = toGateEntry(personalityRaw, "P");
    const designGates = toGateEntry(designRaw, "D");
    const pGateSet = new Set(personalityGates.map((g) => g.gate));
    const dGateSet = new Set(designGates.map((g) => g.gate));

    const definedCenterSource =
      hdJson?.centers?.definedNames ??
      (Array.isArray(hdJson?.centers?.defined)
        ? hdJson.centers.defined.map((center: any) => center?.name)
        : null) ??
      hdJson?.definedCenters ??
      [];
    const definedCenters =
      (Array.isArray(definedCenterSource) ? definedCenterSource : [])
        .map((name: unknown) => normalizeCenterName(String(name || "")))
        .filter(Boolean) as HdCenterKey[];

    const channelSource = Array.isArray(hdJson?.channels)
      ? hdJson.channels
      : Array.isArray(hdJson?.activeChannels)
        ? hdJson.activeChannels
        : Array.isArray(hdJson?.chart?.activeChannels)
          ? hdJson.chart.activeChannels
          : [];
    const activeChannels = channelSource
      .map((ch: any) => {
        const centers = Array.isArray(ch?.centers)
          ? ch.centers
          : [ch?.c1, ch?.c2, ch?.from, ch?.to].filter(Boolean);
        const c1 = centers[0] ? normalizeCenterName(String(centers[0])) : null;
        const c2 = centers[1] ? normalizeCenterName(String(centers[1])) : null;
        if (!c1 || !c2 || c1 === c2) return null;
        const gatesRaw = Array.isArray(ch?.gates) ? ch.gates : [ch?.gate1, ch?.gate2];
        const gates = gatesRaw.map((gate: unknown) => Number(gate)).filter(Number.isFinite);
        const hasP = gates.some((g: number) => pGateSet.has(g));
        const hasD = gates.some((g: number) => dGateSet.has(g));
        const type = hasP && hasD ? "B" : hasP ? "P" : "D";
        return { centers: [c1, c2], gates, type };
      })
      .filter(Boolean) as Array<{ centers: HdCenterKey[]; gates: number[]; type: string }>;

    const hdNotSelfRaw = hdJson?.type?.notSelf ?? typeNotSelf ?? "—";
    const hdNotSelfLabel = hdNotSelfRaw !== "—" ? localizeHumanDesignNotSelf(hdNotSelfRaw) : "—";
    const hdNarrative = [
      hdTypeLabel !== "–" ? tr(`Din typ: ${hdTypeLabel}.`, `Your type: ${hdTypeLabel}.`) : "",
      hdStrategyLabel !== "–" ? tr(`Din strategi: ${hdStrategyLabel}.`, `Your strategy: ${hdStrategyLabel}.`) : "",
      hdAuthorityLabel !== "–" ? tr(`Din auktoritet: ${hdAuthorityLabel}.`, `Your authority: ${hdAuthorityLabel}.`) : "",
      hdProfileLabel !== "–" ? tr(`Din profil: ${hdProfileLabel}.`, `Your profile: ${hdProfileLabel}.`) : "",
      hdDefinitionLabel !== "–" ? tr(`Din definition: ${hdDefinitionLabel}.`, `Your definition: ${hdDefinitionLabel}.`) : "",
    ]
      .filter(Boolean)
      .join(" ");

    return {
      locale: oracleLanguage || "sv-SE",
      summary: {
        type: hdTypeLabel,
        profile: hdProfileLabel,
        definition: hdDefinitionLabel,
        authority: hdAuthorityLabel,
        strategy: hdStrategyLabel,
        notSelf: hdNotSelfLabel,
        incarnationCross: hdIncarnation,
      },
      narrative: hdNarrative,
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
          (hdProfileSource?.unknown_time || profileInfo?.unknown_time ? tr("Okänd", "Unknown") : "—"),
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
    oracleLanguage,
    hdAuthority,
    hdAuthorityLabel,
    hdDefinition,
    hdDefinitionLabel,
    hdIncarnation,
    hdProfileLabel,
    hdStrategy,
    hdStrategyLabel,
    hdType,
    hdTypeLabel,
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
    localizeHumanDesignNotSelf,
    tr,
    typeNotSelf,
  ]);

  const superReportData = useMemo(() => {
    const toDegreeString = (lon?: number | null): string | null => {
      if (typeof lon !== "number") return null;
      const deg = ((lon % 360) + 360) % 360;
      const within = deg % 30;
      const d = Math.floor(within);
      const mFloat = (within - d) * 60;
      const m = Math.floor(mFloat);
      const s = Math.round((mFloat - m) * 60);
      const pad = (v: number) => String(v).padStart(2, "0");
      return `${d}°${pad(m)}'${pad(s)}"`;
    };
    const planetsRaw = Array.isArray(superReportInsights?.astrology_json?.planets)
      ? superReportInsights.astrology_json.planets
      : [];
    const aspectsRaw = Array.isArray(superReportInsights?.astrology_json?.aspects)
      ? superReportInsights.astrology_json.aspects
      : [];
    const housesRaw = Array.isArray(superReportInsights?.astrology_json?.houses?.cusps)
      ? superReportInsights.astrology_json.houses.cusps
      : [];
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
    const zodiacAnimal = superReportInsights?.summary_json?.chinese_zodiac ?? null;
    const zodiacInfo = zodiacAnimal ? zodiacMeta[zodiacAnimal] ?? null : null;
    const hdChannelsRaw = Array.isArray(superReportInsights?.human_design_json?.channels)
      ? superReportInsights.human_design_json.channels
      : [];
    const hdDefinedCentersRaw = Array.isArray(superReportInsights?.human_design_json?.centers?.definedNames)
      ? superReportInsights.human_design_json.centers.definedNames
      : [];
    const hdIncarnationCross =
      superReportInsights?.human_design_json?.incarnationCross?.fullName ||
      superReportInsights?.human_design_json?.incarnationCross?.name ||
      null;
    const hdIncarnationCrossLabel = hdIncarnationCross ? localizeHumanDesignCross(hdIncarnationCross) : null;
    const reportUsernameRaw =
      superReportProfile?.username ??
      profileInfo?.username ??
      superReportProfile?.name ??
      profileInfo?.name ??
      "";
    const reportUsername = String(reportUsernameRaw || "").trim();
    const titleCaseUsername = reportUsername
      ? `${reportUsername.charAt(0).toUpperCase()}${reportUsername.slice(1)}`
      : "";
    const avatarCandidates = Array.from(
      new Set(
        [
          avatarUrl,
          reportUsername ? `/avatars/${reportUsername}.jpg` : null,
          reportUsername ? `/avatars/${reportUsername}.png` : null,
          reportUsername ? `/avatars/${reportUsername.toLowerCase()}.jpg` : null,
          reportUsername ? `/avatars/${reportUsername.toLowerCase()}.png` : null,
          titleCaseUsername ? `/avatars/${titleCaseUsername}.jpg` : null,
          titleCaseUsername ? `/avatars/${titleCaseUsername}.png` : null,
          "/avatars/Default.jpg",
        ].filter(Boolean) as string[]
      )
    );

    return {
      locale: oracleLanguage || "sv-SE",
      generatedAt: new Date().toISOString(),
      user: {
        name: superReportProfile?.name ?? superReportProfile?.username ?? null,
        username: superReportProfile?.username ?? null,
        email: superReportProfile?.email ?? null,
        avatarUrl: avatarCandidates[0] ?? "/avatars/Default.jpg",
        avatarCandidates,
        birthDate: superReportProfile?.birth_date ?? profileForm.birthDate ?? null,
        birthTime: superReportProfile?.birth_time ?? profileForm.birthTime ?? null,
        birthPlace: superReportProfile?.birth_place ?? profileForm.birthPlace ?? null,
        tzName: superReportProfile?.tz_name ?? null,
        tzOffsetMinutes: superReportProfile?.tz_offset_minutes ?? null,
        lat: superReportProfile?.birth_lat ?? null,
        lng: superReportProfile?.birth_lng ?? null,
      },
      astrology: {
        sun: superReportInsights?.summary_json?.astrology?.sun ?? null,
        moon: superReportInsights?.summary_json?.astrology?.moon ?? null,
        ascendant: superReportInsights?.summary_json?.astrology?.ascendant ?? null,
        planets: planetsRaw
          .map((planet: any) => ({
            name: String(planet?.name || "").trim(),
            sign: String(planet?.sign || "").trim() || null,
            house: typeof planet?.house === "number" ? planet.house : null,
            lon: typeof planet?.lon === "number" ? planet.lon : null,
            degree: toDegreeString(typeof planet?.lon === "number" ? planet.lon : null),
            retrograde: Boolean(planet?.retrograde),
          }))
          .filter((planet: { name: string }) => Boolean(planet.name)),
        aspects: aspectsRaw
          .map((aspect: any) => ({
            a: String(aspect?.a || aspect?.planetA || "").trim(),
            b: String(aspect?.b || aspect?.planetB || "").trim(),
            type: String(aspect?.type || "").trim() || null,
            orb: typeof aspect?.orb === "number" ? aspect.orb : null,
          }))
          .filter((aspect: { a: string; b: string }) => aspect.a && aspect.b)
          .slice(0, 48),
        houses: housesRaw.map((lon: any, idx: number) => {
          const normalized = typeof lon === "number" ? (((lon % 360) + 360) % 360) : null;
          const signIndex = normalized === null ? null : Math.floor(normalized / 30);
          return {
            house: idx + 1,
            lon: normalized,
            sign: signIndex === null ? null : signNames[signIndex] ?? null,
          };
        }),
      },
      humanDesign: {
        type: superReportInsights?.summary_json?.human_design?.type ?? null,
        strategy: superReportInsights?.summary_json?.human_design?.strategy ?? null,
        authority: superReportInsights?.summary_json?.human_design?.authority ?? null,
        profile: superReportInsights?.summary_json?.human_design?.profile ?? null,
        role: superReportInsights?.summary_json?.human_design?.role ?? null,
        definition: superReportInsights?.human_design_json?.definition ?? null,
        notSelf: superReportInsights?.human_design_json?.type?.notSelf ?? typeNotSelf ?? null,
        signature: typeSignature || null,
        incarnationCross: hdIncarnationCrossLabel ?? hdIncarnationCross,
        incarnationCrossRaw: hdIncarnationCross,
        definedCenters: hdDefinedCentersRaw.map((center: unknown) => String(center || "").trim()).filter(Boolean),
        channels: hdChannelsRaw
          .map((channel: any) => ({
            gates: Array.isArray(channel?.gates) ? channel.gates.map((gate: unknown) => Number(gate)).filter(Number.isFinite) : [],
            centers: Array.isArray(channel?.centers) ? channel.centers.map((center: unknown) => String(center || "")) : [],
          }))
          .filter((channel: { gates: number[] }) => channel.gates.length > 0),
      },
      humanDesignStandalone: hdReportData,
      chineseZodiac: {
        animal: zodiacAnimal,
        yinYang: zodiacInfo?.yinYang ?? null,
        element: zodiacInfo?.element ?? null,
        trine: zodiacInfo?.trine ?? null,
        earthlyBranch: zodiacInfo?.earthlyBranch ?? null,
        animalChar: zodiacInfo?.animalChar ?? null,
      },
    };
  }, [
    avatarUrl,
    profileInfo?.name,
    profileInfo?.username,
    superReportInsights,
    superReportProfile,
    hdReportData,
    localizeHumanDesignCross,
    oracleLanguage,
    profileForm.birthDate,
    profileForm.birthPlace,
    profileForm.birthTime,
    tr,
    typeNotSelf,
    typeSignature,
  ]);

  const superReportHash = useMemo(() => {
    try {
      return encodeURIComponent(JSON.stringify(superReportData));
    } catch {
      return "";
    }
  }, [superReportData]);

  const reportTemplateVersion = "2026-02-15-r22";
  const superReportBase = `/full_natalanalysrapport.html?v=${encodeURIComponent(reportTemplateVersion)}`;
  const superReportUrl = superReportHash
    ? `${superReportBase}#data=${superReportHash}`
    : superReportBase;
  const superReportPrintUrl = superReportHash
    ? `${superReportBase}#data=${superReportHash}&print=1`
    : `${superReportBase}#print=1`;

  const hdReportHash = useMemo(() => {
    try {
      return encodeURIComponent(JSON.stringify(hdReportData));
    } catch {
      return "";
    }
  }, [hdReportData]);

  const hdReportBase = `/standalone-report.html?v=${encodeURIComponent(reportTemplateVersion)}`;
  const hdReportUrl = hdReportHash
    ? `${hdReportBase}#data=${hdReportHash}`
    : hdReportBase;
  const hdReportPrintUrl = hdReportHash
    ? `${hdReportBase}#data=${hdReportHash}&print=1`
    : `${hdReportBase}#print=1`;

  const hdEmailLink = useMemo(() => {
    const subject = tr("Min Human Design-rapport", "My Human Design Report");
    const body = [
      tr("Här är min Human Design‑rapport:", "Here is my Human Design report:"),
      "",
      `${tr("Typ", "Type")}: ${hdTypeLabel}`,
      `${tr("Strategi", "Strategy")}: ${hdStrategyLabel}`,
      `${tr("Auktoritet", "Authority")}: ${hdAuthorityLabel}`,
      `${tr("Profil", "Profile")}: ${hdProfileLabel}`,
      `${tr("Definition", "Definition")}: ${hdDefinitionLabel}`,
      `${tr("Inkarnationskors", "Incarnation Cross")}: ${hdIncarnation}`,
      "",
      `${tr("Rapport", "Report")}: ${window.location.origin}${hdReportUrl}`,
    ].join("\n");
    const to = hdEmail ? encodeURIComponent(hdEmail) : "";
    return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }, [
    hdAuthorityLabel,
    hdDefinitionLabel,
    hdEmail,
    hdIncarnation,
    hdProfileLabel,
    hdReportUrl,
    hdStrategyLabel,
    hdTypeLabel,
    tr,
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
    if (isSwedish) {
      if (!sign) return "Tecknet visar hur energin uttrycker sig.";
      return `${localizeSignName(sign)} visar hur energin uttrycker sig i din vardag.`;
    }
    if (!sign) return "The sign shows how the energy expresses itself.";
    return signMeaning[sign] ?? "The sign shows how the energy expresses itself.";
  };

  const describeSignDeep = (sign?: string | null) => {
    if (isSwedish) {
      if (!sign) return "Tecknet visar energins stil - hur den vill röra sig, relatera och ta form i vardagen.";
      const tone = signToneSv[sign] ?? "uttrycka sig på sitt eget unika sätt.";
      const gift = signGiftSv[sign] ?? "låta energi bli något både konkret och meningsfullt.";
      return `${signMeaningSv[sign] ?? "Tecknet är energins stil och riktning."} Den tenderar ofta att ${tone} När den är i balans blir gåvan att ${gift}`;
    }
    if (!sign) return "The sign is the style of the energy—how it wants to move.";
    const tone = signTone[sign] ?? "expresses in its own unique way.";
    return `${signMeaning[sign] ?? "The sign is the style of the energy."} It often ${tone}`;
  };

  const describePlanet = (planetName: string, sign?: string | null, house?: number | null) => {
    if (isSwedish) {
      const signText = sign ? ` i ${localizeSignName(sign)}` : "";
      const houseText = house ? ` i ${houseLabel(house)}` : "";
      return `${localizePlanetName(planetName)}${signText}${houseText} beskriver ett viktigt tema i ditt liv.`;
    }
    const planetText = planetMeaning[planetName] ?? "This planet describes a life theme.";
    const signText = describeSign(sign);
    const houseText = house ? houseMeaningText(house) : "";
    const houseSuffix = house ? ` It lands in the ${houseLabel(house)}.` : "";
    return `${planetText} ${signText}${houseSuffix} ${houseText} For you, this is a place where the theme becomes personal and visible.`.trim();
  };

  const describePlanetDeep = (planetName: string, sign?: string | null, house?: number | null) => {
    if (isSwedish) {
      const planetText = planetMeaningSv[planetName] ?? "Den här planeten beskriver ett livstema.";
      const signText = describeSignDeep(sign);
      const houseFocus = houseDetailText(house);
      const houseSuffix = house ? ` Den landar i ${houseLabel(house)} - området för ${houseFocus}` : "";
      const gift = planetGiftSv[planetName] ?? "du fördjupar det som verkligen betyder något för dig.";
      const shadow = planetShadowSv[planetName] ?? "att gå för fort fram utan att stanna upp i det viktiga.";
      return `${planetText} ${signText}${houseSuffix} I gåva visar den att ${gift} I skugga kan den visa sig som ${shadow} För dig är detta platsen där berättelsen samlar hetta och vill levas i praktiken.`.trim();
    }
    const planetText = planetMeaning[planetName] ?? "This planet describes a life theme.";
    const signText = describeSignDeep(sign);
    const houseFocus = houseDetailText(house);
    const houseSuffix = house
      ? ` It lands in the ${houseLabel(house)} — the area of ${houseFocus}`
      : "";
    return `${planetText} ${signText}${houseSuffix} For you, this is where the story gathers its heat and asks to be lived.`.trim();
  };

  const describeAscendant = (sign?: string | null) => {
    if (isSwedish) {
      return `Ascendenten är ditt första intryck och hur du möter världen. ${describeSign(sign)}`;
    }
    const signText = describeSign(sign);
    return `The Ascendant is the “mask” you present to people and your first impression. ${signText} For you, it colors how others read you at a glance.`;
  };

  const describeAscendantDeep = (sign?: string | null) => {
    if (isSwedish) {
      const signText = describeSignDeep(sign);
      const style = sign ? signToneSv[sign] ?? "visa en tydlig och personlig närvaro." : "visa din energi utåt med egen ton.";
      return `Ascendenten är ingången till din karta - hur världen först möter dig. ${signText} Här syns ofta en tendens att ${style} Den formar din stil, din närvaro och energin du skickar ut när du kliver in i ett rum.`;
    }
    const signText = describeSignDeep(sign);
    return `The Ascendant is the doorway of your chart—how the world first meets you. ${signText} It shapes your style, presence, and the energy you cast when you enter a room.`;
  };

  const ordinalHouse = (house?: number | null) => {
    if (!house) return "";
    return houseLabel(house);
  };

  const planetSubtitle = (planetName: string) => {
    const p = planetByName.get(planetName);
    if (!p) return undefined;
    const deg = formatDegree(p.lon);
    const houseLabel = ordinalHouse(p.house);
    return `${localizeSignName(p.sign ?? null) || "–"}, ${deg} · ${houseLabel}`;
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
    const base = (import.meta.env.VITE_AUTHENTIK_URL || "https://auth.sputnet.world").trim();
    return base.replace(/\/$/, "");
  }, []);
  const dateLocale = useMemo(() => oracleLanguage || "sv-SE", [oracleLanguage]);
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
            setProfileError(data?.error || tr("Kunde inte läsa profil.", "Could not load profile."));
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
        setProfileError(tr("Kunde inte läsa profil.", "Could not load profile."));
      } finally {
        setProfileLoading(false);
      }
    };
    loadProfile();
  }, [profileUrl, tr]);

  useEffect(() => {
    if (profileLoading) return;
    let active = true;
    const loadTarotDaily = async () => {
      setTarotLoading(true);
      try {
        const res = await fetch(tarotDailyRequestUrl, { credentials: "include", cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (!active) return;
        if (res.ok && data?.ok && data?.draw) {
          const draw = data.draw as Record<string, unknown>;
          const nextDraw: TarotDailyDraw = {
            cardNumber: Number(draw.card_number ?? 0),
            cardName: String(draw.card_name ?? ""),
            orientation: draw.orientation === "reversed" ? "reversed" : "upright",
            imageUrl: String(draw.image_url ?? ""),
            summary: String(draw.summary ?? ""),
            uprightMeaning: String(draw.upright_meaning ?? ""),
            reversedMeaning: String(draw.reversed_meaning ?? ""),
            moreInfoUrl: draw.more_info_url ? String(draw.more_info_url) : null,
            drawDate: String(draw.draw_date ?? ""),
            drawnAt: String(draw.drawn_at ?? new Date().toISOString()),
            expiresAt: String(draw.expires_at ?? ""),
          };
          setTarotDaily(nextDraw);
          setTarotDrawCreated(Boolean(data.created));
          const sourceMessage = data.created
            ? tr("Nytt dagligt kort drogs och sparades i din profil.", "New daily card drawn and saved to your profile.")
            : tr("Dagens kort var redan draget och laddades från din profil.", "Daily card already drawn today, loaded from your profile database.");
          setTarotStatus(
            nextDraw.expiresAt
              ? `${sourceMessage} ${tr("Nästa dragning efter", "Next draw after")} ${tarotResetLabel(nextDraw.expiresAt, dateLocale)}.`
              : sourceMessage
          );
        } else if (res.status === 401) {
          setTarotDaily(null);
          setTarotDrawCreated(null);
          setTarotStatus(
            typeof data?.message === "string"
              ? data.message
              : tr("Logga in för att ladda ditt dagliga tarotkort.", "Sign in to load your daily tarot card.")
          );
        } else {
          setTarotDrawCreated(null);
          setTarotStatus(
            typeof data?.message === "string"
              ? data.message
              : tr("Kunde inte ladda dagens tarotkort.", "Could not load daily tarot card.")
          );
        }
      } catch {
        if (!active) return;
        setTarotDrawCreated(null);
        setTarotStatus(tr("Kunde inte ladda dagens tarotkort.", "Could not load daily tarot card."));
      } finally {
        if (active) setTarotLoading(false);
      }
    };
    loadTarotDaily();
    return () => {
      active = false;
    };
  }, [dateLocale, profileLoading, tarotDailyRequestUrl, tr]);

  useEffect(() => {
    if (!tarotDaily) return;
    const expiresInMs = new Date(tarotDaily.expiresAt).getTime() - Date.now();
    if (!Number.isFinite(expiresInMs) || expiresInMs <= 0) return;
    const timer = window.setTimeout(() => {
      fetch(tarotDailyRequestUrl, { credentials: "include", cache: "no-store" })
        .then((res) => res.json().catch(() => null))
        .then((data) => {
          if (!data?.ok || !data?.draw) return;
          const draw = data.draw as Record<string, unknown>;
          const nextDraw: TarotDailyDraw = {
            cardNumber: Number(draw.card_number ?? 0),
            cardName: String(draw.card_name ?? ""),
            orientation: draw.orientation === "reversed" ? "reversed" : "upright",
            imageUrl: String(draw.image_url ?? ""),
            summary: String(draw.summary ?? ""),
            uprightMeaning: String(draw.upright_meaning ?? ""),
            reversedMeaning: String(draw.reversed_meaning ?? ""),
            moreInfoUrl: draw.more_info_url ? String(draw.more_info_url) : null,
            drawDate: String(draw.draw_date ?? ""),
            drawnAt: String(draw.drawn_at ?? new Date().toISOString()),
            expiresAt: String(draw.expires_at ?? ""),
          };
          setTarotDaily(nextDraw);
          setTarotDrawCreated(Boolean(data.created));
          const sourceMessage = data.created
            ? tr("Nytt dagligt kort drogs och sparades i din profil.", "New daily card drawn and saved to your profile.")
            : tr("Dagens kort var redan draget och laddades från din profil.", "Daily card already drawn today, loaded from your profile database.");
          setTarotStatus(
            nextDraw.expiresAt
              ? `${sourceMessage} ${tr("Nästa dragning efter", "Next draw after")} ${tarotResetLabel(nextDraw.expiresAt, dateLocale)}.`
              : sourceMessage
          );
        })
        .catch(() => {
          // ignore background refresh failures
        });
    }, expiresInMs + 750);
    return () => window.clearTimeout(timer);
  }, [dateLocale, tarotDaily, tarotDailyRequestUrl, tr]);

  useEffect(() => {
    if (tarotDeck.length > 0 && tarotDeckLocale === oracleLanguage) return;
    let active = true;
    const loadTarotDeck = async () => {
      setTarotDeckLoading(true);
      setTarotDeckError(null);
      try {
        const res = await fetch(tarotDeckRequestUrl, { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (!active) return;
        if (res.ok && data?.ok && Array.isArray(data.cards)) {
          setTarotDeck(data.cards as TarotDeckCard[]);
          setTarotDeckLocale(oracleLanguage);
        } else {
          setTarotDeckError(
            typeof data?.message === "string"
              ? data.message
              : tr("Kunde inte ladda tarotleken.", "Could not load tarot deck.")
          );
        }
      } catch {
        if (!active) return;
        setTarotDeckError(tr("Kunde inte ladda tarotleken.", "Could not load tarot deck."));
      } finally {
        if (active) setTarotDeckLoading(false);
      }
    };
    loadTarotDeck();
    return () => {
      active = false;
    };
  }, [oracleLanguage, tarotDeck.length, tarotDeckLocale, tarotDeckRequestUrl, tr]);

  useEffect(() => {
    setOracleSessionStarted(false);
    setOracleMessages([]);
    setOracleAnswers([]);
    setOracleVoiceTranscript("");
    setOracleQuestionStep(0);
    setTarotReadingCards([]);
    setTarotShuffleActive(false);
    setTarotDealing(false);
    setFocusedReadingCard(null);
    setFocusedReadingCardFlipped(false);
    setTarotReadingSummary(null);
    setOracleStatus(null);
    setLoveReadingStage("intro");
    setLoveReadingChoice("");
    setIntroImageMissing(false);
  }, [selectedSpreadKey]);

  const fetchInsightsOnce = useCallback(async (setLoading = true) => {
    try {
      if (setLoading) setInsightsLoading(true);
      const res = await fetch(insightsUrl, { credentials: "include", cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok && data.insights) {
        setInsights(data.insights as ProfileInsights);
        return data.insights as ProfileInsights;
      } else if (!res.ok && res.status !== 401) {
        setInsightsError(data?.error || tr("Kunde inte läsa profiler.", "Could not load profiles."));
      }
    } catch {
      setInsightsError(tr("Kunde inte läsa profiler.", "Could not load profiles."));
    } finally {
      if (setLoading) setInsightsLoading(false);
    }
    return null;
  }, [insightsUrl, tr]);

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
          throw new Error(insightsData?.error || tr("Kunde inte läsa insikter.", "Could not load insights."));
        }
        if (active) {
          setHdPageInsights(insightsData.insights ?? null);
          setHdPageProfile(profileData?.profile ?? null);
        }
      } catch (err) {
        if (active) {
          setHdPageError(err instanceof Error ? err.message : tr("Kunde inte läsa insikter.", "Could not load insights."));
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
  }, [hdPageUserId, insightsByUserUrl, isHumanDesignPage, profileByUserUrl, tr]);

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
        if (typeof evt.payload.blackjackRound === "number") setBjRound(evt.payload.blackjackRound);
        if (evt.payload.mode) setMatchMode(evt.payload.mode);
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
      if (evt.type === "BJ_ROUND_STARTED" && typeof evt.payload?.round === "number") {
        setBjRound(evt.payload.round);
        setBjHands([]);
        setBjDealer(null);
        ninaRoundStart();
      }
      if (evt.type === "BJ_HAND_STATE" && evt.payload?.state) {
        const payload = evt.payload;
        const next: BjHandView = {
          userId: String(payload.userId ?? ""),
          spot: Number(payload.spot ?? 0),
          handIndex: Number(payload.handIndex ?? 0),
          cards: Array.isArray(payload.state.cards) ? payload.state.cards : [],
          total: Number(payload.state.total ?? 0),
          status: String(payload.state.status ?? ""),
          bet: Number(payload.state.bet ?? 0),
          result: payload.state.result ? String(payload.state.result) : undefined,
          sideBet: payload.state.sideBet ?? null,
          sideResult: payload.state.sideResult ?? null,
          hidden: Number(payload.state.hidden ?? 0),
        };
        if (next.userId === "dealer") {
          setBjDealer(next);
        } else {
          setBjHands((prev) => {
            const key = `${next.userId}:${next.spot}:${next.handIndex}`;
            const filtered = prev.filter((h) => `${h.userId}:${h.spot}:${h.handIndex}` !== key);
            return [...filtered, next];
          });
        }
      }
      if (evt.type === "BJ_ROUND_COMPLETED" && typeof evt.payload?.round === "number") {
        setBjRound(evt.payload.round);
        ninaRoundEnd();
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

  const isSoloBlackjack = () => players.length <= 1;

  const pickNinaLine = (pool: string[]) => pool[Math.floor(Math.random() * pool.length)] || "";

  const speakNina = (line: string) => {
    if (!line) return;
    if (typeof window === "undefined") return;
    const synth = window.speechSynthesis;
    if (!synth) return;
    try {
      synth.cancel();
      const utter = new SpeechSynthesisUtterance(line);
      const voices = synth.getVoices();
      const preferred =
        voices.find((v) => v.lang?.startsWith("sv") && v.name?.toLowerCase().includes("female")) ||
        voices.find((v) => v.lang?.startsWith("sv")) ||
        voices.find((v) => v.lang?.startsWith("en"));
      if (preferred) utter.voice = preferred;
      utter.rate = 1.02;
      utter.pitch = 1.05;
      utter.volume = 0.9;
      synth.speak(utter);
    } catch {
      // ignore speech errors
    }
  };

  const ninaRoundStart = () => {
    const shortLines = [
      "Ny runda. Jag läser dina mönster bättre än du tror.",
      "Kortleken ljuger inte. Frågan är om du gör det.",
      "Andas. Bra spelare vinner långsamt.",
      "En hand i taget. Gör den här vacker.",
      "Tempo slår tur. Visa mig disciplin.",
    ];
    const line = pickNinaLine(shortLines);
    setNinaLine(line);
    addLog(`Nina: ${line}`);
    speakNina(line);
  };

  const ninaRoundEnd = () => {
    const myHands = bjHands.filter((h) => h.userId === selfId);
    const wins = myHands.filter((h) => h.result === "WIN" || h.result === "BLACKJACK").length;
    const loses = myHands.filter((h) => h.result === "LOSE").length;
    const pushes = myHands.filter((h) => h.result === "PUSH").length;

    if (!isSoloBlackjack()) {
      const shortLines = [
        "Snyggt. Men vänta, spelet håller koll.",
        "Du fick mig att jobba lite. Det var kul.",
        "Stabilt. Behåll nerven, inte egot.",
        "Det där var tight. Fortsätt så.",
        "Vi spelar vidare. Jag vill se mer.",
      ];
      const line = pickNinaLine(shortLines);
      setNinaLine(line);
      addLog(`Nina: ${line}`);
      speakNina(line);
      return;
    }

    const deepLines = [
      `Du tog ${wins} vinster, ${loses} förluster och ${pushes} push. När du vinner, vinner du stort. När du förlorar, förlora litet.`,
      `Resultat: ${wins} vinst, ${loses} förlust, ${pushes} push. Du har disciplin, men låt inte känslan styra insatsen.`,
      `Jag ser ${wins} vinster och ${loses} förluster. Rensa bort brus: välj bra spots och lämna resten.`,
      `Du är nära. ${wins} vinster, ${loses} förluster. Dubbel när du har kant, annars vila handen.`,
      `Siffrorna säger ${wins}-${loses} med ${pushes} neutrala. Din edge lever i valet, inte i turen.`,
    ];
    const line = pickNinaLine(deepLines);
    setNinaLine(line);
    addLog(`Nina: ${line}`);
    speakNina(line);
  };

  const createMatch = () => {
    if (!connected) {
      addLog("not_connected");
      return;
    }
    socket.emit("event", { type: "MATCH_CREATE", mode: "FIVE_KAMP" });
    addLog("sent: MATCH_CREATE");
  };

  const createBlackjackMatch = () => {
    if (!connected) {
      addLog("not_connected");
      return;
    }
    setAutoReady(true);
    socket.emit("event", { type: "MATCH_CREATE", mode: "BLACKJACK_ONLY" });
    addLog("sent: MATCH_CREATE (BLACKJACK_ONLY)");
  };

  useEffect(() => {
    if (!autoReady) return;
    if (!matchId) return;
    // For blackjack-only we can auto-ready to jump directly into the game.
    readyUp();
    setAutoReady(false);
  }, [autoReady, matchId]);

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

  const placeBjBet = () => {
    if (!matchId || !bjRound) return;
    const spots = bjSpots
      .split(/[,\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 7);
    const unique = Array.from(new Set(spots));
    const sideBets =
      bjSide === "NONE"
        ? []
        : unique.map((spot) => ({ spot, choice: bjSide }));
    socket.emit("event", {
      type: "BJ_BET_PLACED",
      matchId,
      round: bjRound,
      spots: unique,
      bet: Math.trunc(bjBet),
      sideBets,
    });
    addLog("sent: BJ_BET_PLACED");
  };

  const sendBjAction = (spot: number, action: "HIT" | "STAND" | "DOUBLE" | "SPLIT", handIndex?: number) => {
    if (!matchId || !bjRound) return;
    socket.emit("event", { type: "BJ_HAND_ACTION", matchId, round: bjRound, spot, action, handIndex });
    addLog(`sent: BJ_HAND_ACTION ${action}`);
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
      setProfileStatus(tr("Geolokalisering stöds inte i denna webbläsare.", "Geolocation is not supported in this browser."));
      return;
    }
    setProfileStatus(tr("Hämtar plats...", "Fetching location..."));
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
        setProfileStatus(tr("Plats hämtad.", "Location fetched."));
      },
      () => {
        setProfileStatus(tr("Kunde inte hämta plats.", "Could not fetch location."));
      },
      { enableHighAccuracy: false, timeout: 8000 }
    );
  };

  const fileToDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        if (!result) {
          reject(new Error("file_read_failed"));
          return;
        }
        resolve(result);
      };
      reader.onerror = () => reject(new Error("file_read_failed"));
      reader.readAsDataURL(file);
    });

  const loadImageFromDataUrl = (dataUrl: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image_decode_failed"));
      img.src = dataUrl;
    });

  const clearAvatarDraft = useCallback(() => {
    setAvatarDraftDataUrl(null);
    setAvatarDraftName("");
    setAvatarDraftZoom(1);
    setAvatarDraftOffsetX(0);
    setAvatarDraftOffsetY(0);
    setAvatarDraftRotation(0);
    setAvatarUploadStyle("plain");
    avatarDraftImageRef.current = null;
  }, []);

  const drawAvatarEditorFrame = useCallback(
    (canvas: HTMLCanvasElement, image: HTMLImageElement, outputSize: number) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = outputSize;
      canvas.height = outputSize;
      ctx.clearRect(0, 0, outputSize, outputSize);

      const coverScale = Math.max(outputSize / image.width, outputSize / image.height);
      const zoomScale = clamp(avatarDraftZoom, 1, AVATAR_EDITOR_MAX_ZOOM);
      const shiftX = (clamp(avatarDraftOffsetX, -100, 100) / 100) * outputSize * AVATAR_EDITOR_MAX_SHIFT_RATIO;
      const shiftY = (clamp(avatarDraftOffsetY, -100, 100) / 100) * outputSize * AVATAR_EDITOR_MAX_SHIFT_RATIO;
      const rotationRad = (normalizeDegrees(avatarDraftRotation) * Math.PI) / 180;

      ctx.save();
      ctx.translate(outputSize / 2 + shiftX, outputSize / 2 + shiftY);
      ctx.rotate(rotationRad);
      ctx.scale(coverScale * zoomScale, coverScale * zoomScale);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, -image.width / 2, -image.height / 2);
      ctx.restore();
    },
    [avatarDraftOffsetX, avatarDraftOffsetY, avatarDraftRotation, avatarDraftZoom]
  );

  useEffect(() => {
    const canvas = avatarPreviewCanvasRef.current;
    const image = avatarDraftImageRef.current;
    if (!canvas || !image || !avatarDraftDataUrl) return;
    drawAvatarEditorFrame(canvas, image, AVATAR_EDITOR_PREVIEW_SIZE);
  }, [avatarDraftDataUrl, avatarDraftOffsetX, avatarDraftOffsetY, avatarDraftRotation, avatarDraftZoom, drawAvatarEditorFrame]);

  const onAvatarFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    event.stopPropagation();
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setAvatarUploadError(tr("Välj en bildfil (jpg, png eller webp).", "Choose an image file (jpg, png, or webp)."));
      setAvatarUploadStatus(null);
      return;
    }
    if (file.size > MAX_AVATAR_FILE_BYTES) {
      setAvatarUploadError(
        tr("Bilden är för stor. Max storlek är 8 MB.", "Image is too large. Maximum file size is 8 MB.")
      );
      setAvatarUploadStatus(null);
      return;
    }
    setAvatarUploadBusy(true);
    setAvatarUploadError(null);
    setAvatarUploadStatus(tr("Förbereder förhandsvisning...", "Preparing preview..."));
    try {
      const imageDataUrl = await fileToDataUrl(file);
      const image = await loadImageFromDataUrl(imageDataUrl);
      avatarDraftImageRef.current = image;
      setAvatarDraftDataUrl(imageDataUrl);
      setAvatarDraftName(file.name || "avatar");
      setAvatarDraftZoom(1);
      setAvatarDraftOffsetX(0);
      setAvatarDraftOffsetY(0);
      setAvatarDraftRotation(0);
      setAvatarUploadStyle("plain");
      setAvatarUploadStatus(
        tr("Förhandsvisning klar. Justera och spara.", "Preview ready. Adjust and save.")
      );
    } catch (error) {
      setAvatarUploadError(tr("Kunde inte läsa bilden.", "Could not read the image."));
      setAvatarUploadStatus(null);
    } finally {
      setAvatarUploadBusy(false);
    }
  };

  const saveAvatarDraft = async (event?: { stopPropagation: () => void }) => {
    event?.stopPropagation();
    const image = avatarDraftImageRef.current;
    if (!avatarDraftDataUrl || !image) {
      setAvatarUploadError(tr("Välj en bild först.", "Pick an image first."));
      setAvatarUploadStatus(null);
      return;
    }
    setAvatarUploadBusy(true);
    setAvatarUploadError(null);
    setAvatarUploadStatus(
      avatarUploadStyle === "gta5"
        ? tr("Sparar och genererar GTA-stil...", "Saving and generating GTA style...")
        : tr("Sparar avatar...", "Saving avatar...")
    );
    try {
      const exportCanvas = document.createElement("canvas");
      drawAvatarEditorFrame(exportCanvas, image, AVATAR_EDITOR_EXPORT_SIZE);
      const imageDataUrl = exportCanvas.toDataURL("image/jpeg", 0.92);
      const response = await fetch(profileAvatarApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ imageDataUrl, style: avatarUploadStyle }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        if (data?.error === "image_too_large") {
          throw new Error("image_too_large");
        }
        throw new Error("avatar_upload_failed");
      }
      setAvatarVersion(Date.now());
      setAvatarUploadStatus(tr("Avatar uppdaterad.", "Avatar updated."));
      clearAvatarDraft();
    } catch (error) {
      const code = (error as Error)?.message;
      if (code === "image_too_large") {
        setAvatarUploadError(
          tr("Bilden är för stor efter uppladdning. Max är 8 MB.", "Image is too large after upload. Max size is 8 MB.")
        );
      } else {
        setAvatarUploadError(tr("Kunde inte ladda upp avatar.", "Could not upload avatar."));
      }
      setAvatarUploadStatus(null);
    } finally {
      setAvatarUploadBusy(false);
    }
  };

  const rotateAvatarDraft = (deltaDegrees: number) => {
    setAvatarDraftRotation((current) => normalizeDegrees(current + deltaDegrees));
  };

  const openAvatarUpload = (event?: { stopPropagation: () => void }) => {
    event?.stopPropagation();
    if (avatarUploadBusy) return;
    avatarFileInputRef.current?.click();
  };

  const closeAvatarModal = () => {
    setIsAvatarModalOpen(false);
    clearAvatarDraft();
  };

  const openAvatarModal = (event?: { stopPropagation: () => void }) => {
    event?.stopPropagation();
    setAvatarUploadError(null);
    setAvatarUploadStatus(null);
    setIsAvatarModalOpen(true);
  };

  const saveProfile = async () => {
    if (!profileForm.birthDate || !profileForm.birthPlace.trim()) {
      setProfileError(tr("Fyll i födelsedatum och födelseplats först.", "Please fill in date of birth and place of birth first."));
      return;
    }
    if (!profileForm.birthLat.trim() || !profileForm.birthLng.trim()) {
      setProfileError(tr("Välj plats från listan eller ange koordinater.", "Select a place from the list or enter coordinates."));
      return;
    }
      setProfileStatus(tr("Sparar...", "Saving..."));
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
        setProfileError(data?.error || tr("Kunde inte spara.", "Could not save."));
        setProfileStatus(null);
        return;
      }
      if (data?.profile) {
        setProfileInfo(data.profile as ProfilePayload);
      }
      setProfileStatus(tr("Sparat. Beräknar profil...", "Saved. Calculating profile..."));
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
          setProfileStatus(tr("Sparat, men beräkningen misslyckades.", "Saved, but calculation failed."));
        } else {
          setProfileStatus(tr("Sparat och beräknat.", "Saved and calculated."));
          // Always fetch the persisted insights shape after calc completes.
          await pollInsights();
        }
      } catch {
        setProfileStatus(tr("Sparat, men beräkningen misslyckades.", "Saved, but calculation failed."));
      }
      try {
        const refreshed = await fetch(profileUrl, { credentials: "include" });
        const refreshedData = await refreshed.json().catch(() => null);
        if (refreshed.ok && refreshedData?.ok && refreshedData.profile) {
          const merged = {
            ...(refreshedData.profile as ProfilePayload),
            ...(refreshedData.user as UserInfo),
          };
          setProfileInfo(merged);
        }
      } catch {
        // ignore refresh failures
      }
      setProfileMissing(false);
      setShowEditForm(false);
    } catch (err) {
      setProfileError(tr("Kunde inte spara.", "Could not save."));
      setProfileStatus(null);
    }
  };

  return (
    <main className={`app ${isTarotPage ? "app-tarot-cinema" : ""}`}>
      {!isTarotPage ? (
        <nav className="top-nav">
          <div className="brand">CHKN</div>
          <div className="nav-links">
            <a className={isGamesPage ? "nav-link active" : "nav-link"} href="/lobby">
              {tr("Spel", "Games")}
            </a>
            <a className={isTarotPage ? "nav-link active" : "nav-link"} href="/tarot/oracle">
              {tr("Tarot", "Tarot")}
            </a>
            <a className={isProfilePage ? "nav-link active" : "nav-link"} href="/profile">
              {tr("Profil", "Profile")}
            </a>
            <a className={isSettingsPage ? "nav-link active" : "nav-link"} href="/settings">
              {tr("Inställningar", "Settings")}
            </a>
            <label className="tarot-pref">
              <span>{tr("Språk", "Language")}</span>
              <select
                className="input"
                value={oracleLanguage}
                onChange={(e) => setOracleLanguage(e.target.value)}
              >
                {ORACLE_LANGUAGES.map((lang) => (
                  <option key={`nav-lang-${lang.code}`} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </nav>
      ) : null}

      {!isProfilePage && modal ? (
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
                aria-label={tr("Stäng", "Close")}
                title={tr("Stäng", "Close")}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              {modal.imageUrl ? (
                <div className="modal-media">
                  <img
                    className="modal-image tarot-modal-image"
                    src={modal.imageUrl}
                    alt={modal.imageAlt || modal.title}
                    loading="lazy"
                  />
                </div>
              ) : null}
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
                    aria-label={tr("Stäng", "Close")}
                    title={tr("Stäng", "Close")}
                  >
                    ×
                  </button>
                </div>
                <div className="modal-body">
                  {modal.imageUrl ? (
                    <div className="modal-media">
                      <img
                        className="modal-image tarot-modal-image"
                        src={modal.imageUrl}
                        alt={modal.imageAlt || modal.title}
                        loading="lazy"
                      />
                    </div>
                  ) : null}
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
          {isAvatarModalOpen ? (
            <div
              className="modal-backdrop"
              role="dialog"
              aria-modal="true"
              onClick={closeAvatarModal}
            >
              <div className="modal avatar-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <div className="modal-title">
                    <div>
                      <h3>{tr("Kontoavatar", "Account avatar")}</h3>
                      <p className="modal-subtitle">
                        {tr(
                          "Ladda upp en bild, förhandsgranska och spara när du är nöjd.",
                          "Upload an image, preview it, and save when you're happy."
                        )}
                      </p>
                    </div>
                  </div>
                  <button
                    className="modal-close"
                    onClick={closeAvatarModal}
                    aria-label={tr("Stäng", "Close")}
                    title={tr("Stäng", "Close")}
                  >
                    ×
                  </button>
                </div>
                <div className="modal-body avatar-modal-body">
                  <div className="avatar-modal-current">
                    <img
                      className="avatar-modal-image"
                      src={avatarUrl}
                      alt={profileInfo?.username ? `${profileInfo.username} avatar` : "Avatar"}
                      onError={(event) => {
                        event.currentTarget.src = "/avatars/Default.jpg";
                      }}
                    />
                    <p className="avatar-modal-meta">
                      <strong>{tr("Användarnamn", "Username")}:</strong> {profileInfo?.username ?? "—"}
                    </p>
                    <p className="avatar-modal-meta">
                      <strong>{tr("E-post", "Email")}:</strong> {profileInfo?.email ?? "—"}
                    </p>
                  </div>
                  <div className="avatar-modal-actions">
                    <button
                      type="button"
                      className="btn-primary avatar-modal-edit-btn"
                      onClick={(event) => openAvatarUpload(event)}
                      disabled={avatarUploadBusy}
                    >
                      {avatarDraftDataUrl
                        ? tr("Välj annan bild", "Choose another image")
                        : tr("Välj bild", "Choose image")}
                    </button>
                    {avatarDraftDataUrl ? (
                      <button
                        type="button"
                        className="btn-primary avatar-modal-save-btn"
                        onClick={(event) => saveAvatarDraft(event)}
                        disabled={avatarUploadBusy}
                      >
                        {avatarUploadBusy ? tr("Sparar...", "Saving...") : tr("Spara avatar", "Save avatar")}
                      </button>
                    ) : null}
                    {avatarDraftDataUrl ? (
                      <button
                        type="button"
                        className="btn-ghost avatar-modal-cancel-btn"
                        onClick={() => {
                          clearAvatarDraft();
                          setAvatarUploadStatus(null);
                          setAvatarUploadError(null);
                        }}
                        disabled={avatarUploadBusy}
                      >
                        {tr("Avbryt", "Cancel")}
                      </button>
                    ) : null}
                    <a
                      className="btn-ghost avatar-modal-account-link"
                      href={`${authBaseUrl}/if/user/`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {tr("Öppna kontosidan", "Open account page")}
                    </a>
                  </div>
                  <input
                    ref={avatarFileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="avatar-upload-input"
                    onChange={onAvatarFileSelected}
                  />
                  {avatarDraftDataUrl ? (
                    <div className="avatar-editor-card">
                      <p className="avatar-editor-title">
                        {tr("Förhandsvisning innan du sparar", "Preview before saving")}
                      </p>
                      {avatarDraftName ? (
                        <p className="avatar-editor-meta">
                          <strong>{tr("Fil", "File")}:</strong> {avatarDraftName}
                        </p>
                      ) : null}
                      <div className="avatar-editor-preview">
                        <canvas
                          ref={avatarPreviewCanvasRef}
                          className="avatar-editor-canvas"
                          width={AVATAR_EDITOR_PREVIEW_SIZE}
                          height={AVATAR_EDITOR_PREVIEW_SIZE}
                        />
                      </div>
                      <div className="avatar-editor-controls">
                        <div className="avatar-editor-control">
                          <span>{tr("Stil", "Style")}</span>
                          <div className="avatar-style-toggle">
                            <button
                              type="button"
                              className={`avatar-style-choice ${avatarUploadStyle === "plain" ? "active" : ""}`}
                              onClick={() => setAvatarUploadStyle("plain")}
                              disabled={avatarUploadBusy}
                            >
                              {tr("Behåll original", "Keep original")}
                            </button>
                            <button
                              type="button"
                              className={`avatar-style-choice ${avatarUploadStyle === "gta5" ? "active" : ""}`}
                              onClick={() => setAvatarUploadStyle("gta5")}
                              disabled={avatarUploadBusy}
                            >
                              {tr("GTA 5-stil", "GTA 5 style")}
                            </button>
                          </div>
                        </div>
                        <label className="avatar-editor-control">
                          <span>{tr("Zoom", "Zoom")}: {avatarDraftZoom.toFixed(2)}x</span>
                          <input
                            type="range"
                            min={1}
                            max={AVATAR_EDITOR_MAX_ZOOM}
                            step={0.01}
                            value={avatarDraftZoom}
                            onChange={(event) => setAvatarDraftZoom(Number(event.target.value))}
                            disabled={avatarUploadBusy}
                          />
                        </label>
                        <label className="avatar-editor-control">
                          <span>{tr("Horisontell justering", "Horizontal adjustment")}: {avatarDraftOffsetX}%</span>
                          <input
                            type="range"
                            min={-100}
                            max={100}
                            step={1}
                            value={avatarDraftOffsetX}
                            onChange={(event) => setAvatarDraftOffsetX(Number(event.target.value))}
                            disabled={avatarUploadBusy}
                          />
                        </label>
                        <label className="avatar-editor-control">
                          <span>{tr("Vertikal justering", "Vertical adjustment")}: {avatarDraftOffsetY}%</span>
                          <input
                            type="range"
                            min={-100}
                            max={100}
                            step={1}
                            value={avatarDraftOffsetY}
                            onChange={(event) => setAvatarDraftOffsetY(Number(event.target.value))}
                            disabled={avatarUploadBusy}
                          />
                        </label>
                        <div className="avatar-editor-control avatar-rotate-control">
                          <span>{tr("Rotation", "Rotation")}: {normalizeDegrees(avatarDraftRotation)}°</span>
                          <div className="avatar-rotate-actions">
                            <button
                              type="button"
                              className="btn-ghost avatar-rotate-btn"
                              onClick={() => rotateAvatarDraft(-90)}
                              disabled={avatarUploadBusy}
                            >
                              {tr("Vänster 90°", "Left 90°")}
                            </button>
                            <button
                              type="button"
                              className="btn-ghost avatar-rotate-btn"
                              onClick={() => rotateAvatarDraft(90)}
                              disabled={avatarUploadBusy}
                            >
                              {tr("Höger 90°", "Right 90°")}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <span className="avatar-upload-note">
                      {tr(
                        "Välj en bild för att öppna förhandsvisning och enkel redigering.",
                        "Choose an image to open preview and simple editing."
                      )}
                    </span>
                  )}
                  {avatarUploadStatus ? (
                    <span className="avatar-upload-note">{avatarUploadStatus}</span>
                  ) : null}
                  {avatarUploadError ? (
                    <span className="avatar-upload-note bad">{avatarUploadError}</span>
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
                      <h3>{tr("Human Design-chart", "Human Design Chart")}</h3>
                      <p className="modal-subtitle">
                        Genererad från din födelsedata (födelsedatum, tid och plats).
                      </p>
                    </div>
                  </div>
                  <button
                    className="modal-close"
                    onClick={() => setIsHdChartOpen(false)}
                    aria-label={tr("Stäng", "Close")}
                    title={tr("Stäng", "Close")}
                  >
                    ×
                  </button>
                </div>
                <div className="modal-body hd-modal-body">
                  <iframe
                    className="hd-report-frame"
                    title={tr("Human Design-rapport", "Human Design Report")}
                    src={hdReportUrl}
                  />
                  <div className="modal-actions hd-modal-actions">
                    <a className="btn-primary" href={hdReportPrintUrl} target="_blank" rel="noreferrer">
                      {tr("Ladda ner rapport (PDF)", "Download report (PDF)")}
                    </a>
                    <a className="btn-ghost" href={hdEmailLink}>
                      {tr("Skicka till min e-post", "Send to my email")}
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
            <p className="eyebrow">{tr("Profil", "Profile")}</p>
            <h2>{tr("Börja med att skapa din Sputnet Space Astro-profil", "First generate your Sputnet Space Astro Profile")}</h2>
            <p className="lead">
              {tr(
                "Vi använder detta för att beräkna din profil och ge mer träffsäkra tolkningar.",
                "We will use this to calculate who you are, and to be able to read you better."
              )}
            </p>
        </div>
        <div className="profile-badge">
            <span>
              {profileLoading
                ? tr("Laddar…", "Loading…")
                : profileMissing
                  ? tr("Saknas", "Missing")
                  : profileDirty
                    ? tr("Ändringar", "Changes")
                    : tr("Redo", "Ready")}
            </span>
        </div>
        </div>

        <div className="profile-grid">
          <div className="profile-field">
            <label>{tr("Födelsedatum", "Date of birth")}</label>
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
            <p className="help-text">{tr("År, månad och dag för födelse", "Year Month and Day of birth")}</p>
          </div>
          <div className="profile-field">
            <label>{tr("Födelsetid", "Time of birth")}</label>
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
              {tr("Okänd tid", "Unknown time")}
            </label>
          </div>
          <div className="profile-field">
            <label>{tr("Födelseort", "City of birth")}</label>
            <div className="autocomplete">
              <input
                type="text"
                placeholder={tr("Stad, land", "City, country")}
                value={profileForm.birthPlace}
                onChange={(e) => handleProfileChange("birthPlace", e.target.value)}
              />
              {placeLoading ? <div className="autocomplete-status">{tr("Söker…", "Searching…")}</div> : null}
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
                {tr("Ange koordinater", "Enter coordinates")}
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={showMap}
                  onChange={(e) => setShowMap(e.target.checked)}
                />
                {tr("Välj på karta", "Pick on map")}
              </label>
            </div>
          </div>
          {showCoords ? (
            <div className="profile-field">
              <label>{tr("Koordinater", "Coordinates")}</label>
              <div className="coord-row">
                <input
                  type="text"
                  placeholder={tr("Lat", "Lat")}
                  value={profileForm.birthLat}
                  onChange={(e) => handleProfileChange("birthLat", e.target.value)}
                />
                <input
                  type="text"
                  placeholder={tr("Lng", "Lng")}
                  value={profileForm.birthLng}
                  onChange={(e) => handleProfileChange("birthLng", e.target.value)}
                />
              </div>
              <button className="btn-ghost" type="button" onClick={useDeviceLocation}>
                {tr("Använd min plats", "Use my location")}
              </button>
            </div>
          ) : null}
        </div>

        {showMap ? (
          <div className="map-panel">
            <div className="map-header">
              <h3>{tr("Välj en plats", "Pick a location")}</h3>
              <p>{tr("Klicka för att sätta en ungefärlig koordinat.", "Click to set an approximate coordinate.")}</p>
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
            {tr("Spara profil", "Save profile")}
          </button>
          {profileStatus ? <span className="status">{profileStatus}</span> : null}
          {profileError ? <span className="status bad">{profileError}</span> : null}
        </div>
      </section>
          ) : null}

          {!profileMissing ? (
          <section className="profile-card profile-insights">
            <p className="eyebrow">{tr("Din profil", "Your profile")}</p>

          <div className="summary-row">
            <div
              className="summary-card account-card"
              role="button"
              tabIndex={0}
              onClick={() =>
                openModal(
                  tr("Konto", "Account"),
                  tr(
                    "Ditt användarnamn och din e-post hanteras i Sputnets SpaceDatabase. Där kan du visa eller uppdatera säkerhet och andra inställningar.",
                    "Your username and email are managed in Sputnet's SpaceDatabase. You can view or update your security and other settings there."
                  ),
                  undefined,
                  [{ label: tr("Öppna kontosidan", "Open account page"), href: `${authBaseUrl}/if/user/` }]
                )
              }
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                openModal(
                  tr("Konto", "Account"),
                  tr(
                    "Ditt användarnamn och din e-post hanteras i Sputnets SpaceDatabase. Där kan du visa eller uppdatera säkerhet och andra inställningar.",
                    "Your username and email are managed in Sputnet's SpaceDatabase. You can view or update your security and other settings there."
                  ),
                  undefined,
                  [{ label: tr("Öppna kontosidan", "Open account page"), href: `${authBaseUrl}/if/user/` }]
                );
              }}
            >
              <div className="summary-card-header">
                <h3>{tr("Konto", "Account")}</h3>
              </div>
              <div className="summary-items">
                <div className="summary-item">
                  <button
                    type="button"
                    className="summary-icon avatar-icon"
                    onClick={(e) => openAvatarModal(e)}
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
                    <p className="summary-label">{tr("Användarnamn", "Username")}</p>
                    <p className="summary-value">{profileInfo?.username ?? "—"}</p>
                  </div>
                </div>
                <div className="summary-item">
                  <span className="summary-icon">✉</span>
                  <div>
                    <p className="summary-label">{tr("E-post", "Email")}</p>
                    <p className="summary-value">
                      {profileInfo?.email ? (
                        <a href={`mailto:${profileInfo.email}`}>{tr("E-post", "Email")}</a>
                      ) : (
                        "—"
                      )}
                    </p>
                  </div>
                </div>
                <div className="summary-item">
                  <span className="summary-icon">✎</span>
                  <div>
                    <p className="summary-label">{tr("Ändra", "Edit")}</p>
                    <p className="summary-value">{tr("Ändra konto", "Change account")}</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="summary-card">
              <h3>{tr("Astrologi", "Astrology")}</h3>
              <div className="summary-items">
                <button
                  type="button"
                  className="summary-item"
                  onClick={() =>
                    openModal(
                      tr("Sol", "Sun"),
                      `${describePlanetDeep(
                        "Sun",
                        insights?.summary_json?.astrology?.sun ?? null,
                        null
                      )} ${tr(
                        "Ditt soltecken visar hur du lyser, leder och vad som ger dig kärnenergi.",
                        "Your Sun sign describes how you shine and lead in life, and what energizes you at your core."
                      )}`,
                      localizeSignName(insights?.summary_json?.astrology?.sun ?? null) || undefined
                    )
                  }
                >
                  <span className="summary-icon">☉</span>
                  <div>
                    <p className="summary-label">{tr("Sol", "Sun")}</p>
                    <p className="summary-value">
                      <span className="summary-sign">{signSymbolFor(insights?.summary_json?.astrology?.sun ?? null)}</span>
                      {localizeSignName(insights?.summary_json?.astrology?.sun ?? null) || "–"}
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  className="summary-item"
                  onClick={() =>
                    openModal(
                      tr("Måne", "Moon"),
                      `${describePlanetDeep(
                        "Moon",
                        insights?.summary_json?.astrology?.moon ?? null,
                        null
                      )} ${tr(
                        "Ditt måntecken visar hur du bearbetar känslor och vad som får dig att känna trygghet.",
                        "Your Moon sign shows how you process feelings and what makes you feel safe."
                      )}`,
                      localizeSignName(insights?.summary_json?.astrology?.moon ?? null) || undefined
                    )
                  }
                >
                  <span className="summary-icon">☾</span>
                  <div>
                    <p className="summary-label">{tr("Måne", "Moon")}</p>
                    <p className="summary-value">
                      <span className="summary-sign">{signSymbolFor(insights?.summary_json?.astrology?.moon ?? null)}</span>
                      {localizeSignName(insights?.summary_json?.astrology?.moon ?? null) || "–"}
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  className="summary-item"
                  onClick={() =>
                    openModal(
                      tr("Ascendent", "Ascendant"),
                      `${describeAscendantDeep(insights?.summary_json?.astrology?.ascendant ?? null)} ${tr(
                        "Det färgar ofta din stil och den direkta känslan du utstrålar.",
                        "It often colors your style and the immediate vibe you give off."
                      )}`,
                      localizeSignName(insights?.summary_json?.astrology?.ascendant ?? null) || undefined
                    )
                  }
                >
                  <span className="summary-icon">↥</span>
                  <div>
                    <p className="summary-label">{tr("Ascendent", "Ascendant")}</p>
                    <p className="summary-value">
                      <span className="summary-sign">{signSymbolFor(insights?.summary_json?.astrology?.ascendant ?? null)}</span>
                      {localizeSignName(insights?.summary_json?.astrology?.ascendant ?? null) || "–"}
                    </p>
                  </div>
                </button>
              </div>
            </div>

            <div className="summary-card">
              <h3>{tr("Human Design", "Human Design")}</h3>
              <div className="summary-items">
                <button
                  type="button"
                  className="summary-item"
                  onClick={() =>
                    openModal(
                      tr("Energityp", "Energy Type"),
                      (() => {
                        const type = insights?.summary_json?.human_design?.type ?? "";
                        const base =
                          isSwedish
                            ? tr(
                                "Energitypen beskriver din övergripande livskraft och hur du bäst samspelar med världen.",
                                "Energy type describes your overall life force and how you best interact with the world."
                              )
                            : insights?.human_design_json?.type?.description ||
                              tr(
                                "Energitypen beskriver din övergripande livskraft och hur du bäst samspelar med världen.",
                                "Energy type describes your overall life force and how you best interact with the world."
                              );
                        const extra = type
                          ? (isSwedish ? humanDesignTypeDetailSv[type] : humanDesignTypeDetail[type]) ?? ""
                          : "";
                        const example = type
                          ? (isSwedish ? humanDesignExamplesSv[type] : humanDesignExamples[type]) ?? ""
                          : "";
                        return `${base} ${extra} ${example} ${tr(
                          "För dig är detta grundsättet du fungerar på och hur andra känner din energi.",
                          "For you, this is your baseline way of operating and how others feel your energy."
                        )}`.trim();
                      })()
                    )
                  }
                >
                  <span className="summary-icon">⚡</span>
                  <div>
                    <p className="summary-label">{tr("Energityp", "Energy Type")}</p>
                    <p className="summary-value">
                      {localizeHumanDesignType(insights?.summary_json?.human_design?.type ?? null) || "–"}
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  className="summary-item"
                  onClick={() =>
                    openModal(
                      tr("Strategi", "Strategy"),
                      (() => {
                        const strategy =
                          insights?.human_design_json?.type?.strategy ||
                          insights?.summary_json?.human_design?.strategy ||
                          "";
                        const strategyLabel = localizeHumanDesignStrategy(strategy);
                        const base =
                          tr(
                            "Strategi är din praktiska väg till bättre beslut och mindre motstånd.",
                            "Strategy is your practical path for decisions and less resistance."
                          );
                        const extra = strategy
                          ? (isSwedish
                              ? humanDesignStrategyDetailSv[strategy]
                              : humanDesignStrategyDetail[strategy]) ?? ""
                          : "";
                        return `${base} ${strategy ? `${tr("Strategi", "Strategy")}: ${strategyLabel || strategy}.` : ""} ${extra} ${tr(
                          "Det är vägen som minskar friktion och hjälper dig att linjera dina handlingar.",
                          "It’s the path that reduces friction and helps you align your actions."
                        )}`.trim();
                      })()
                    )
                  }
                >
                  <span className="summary-icon">↳</span>
                  <div>
                    <p className="summary-label">{tr("Strategi", "Strategy")}</p>
                    <p className="summary-value">
                      {localizeHumanDesignStrategy(insights?.summary_json?.human_design?.strategy ?? null) || "–"}
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  className="summary-item"
                  onClick={() =>
                    openModal(
                      tr("Auktoritet", "Authority"),
                      (() => {
                        const authority = insights?.summary_json?.human_design?.authority ?? "";
                        const authorityLabel = localizeHumanDesignAuthority(authority);
                        const base =
                          isSwedish
                            ? tr(
                                "Auktoritet visar var din mest tillförlitliga inre kompass finns.",
                                "Authority shows where your most reliable inner compass lives."
                              )
                            : insights?.human_design_json?.authority?.description ||
                              tr(
                                "Auktoritet visar var din mest tillförlitliga inre kompass finns.",
                                "Authority shows where your most reliable inner compass lives."
                              );
                        const extra = authority
                          ? (isSwedish
                              ? humanDesignAuthorityDetailSv[authority]
                              : humanDesignAuthorityDetail[authority]) ?? ""
                          : "";
                        return `${base} ${authority ? `${tr("Auktoritet", "Authority")}: ${authorityLabel || authority}.` : ""} ${extra} ${tr(
                          "Det är ditt mest tillförlitliga beslutscenter över tid.",
                          "It’s your most trusted decision‑making center over time."
                        )}`.trim();
                      })()
                    )
                  }
                >
                  <span className="summary-icon">◎</span>
                  <div>
                    <p className="summary-label">{tr("Auktoritet", "Authority")}</p>
                    <p className="summary-value">
                      {localizeHumanDesignAuthority(insights?.summary_json?.human_design?.authority ?? null) || "–"}
                    </p>
                  </div>
                </button>
              </div>
            </div>

            <div className="summary-card zodiac-card">
              <h3>{tr("Kinesisk zodiak", "Chinese zodiac")}</h3>
              <div className="summary-items">
                <div className="zodiac-stack">
                  <button
                    type="button"
                    className="summary-item zodiac-row-button"
                    onClick={() =>
                      openModal(
                      tr("Årsdjur", "Year animal"),
                      `${
                          (isSwedish
                            ? ZODIAC_MEANING_SV[insights?.summary_json?.chinese_zodiac ?? ""]
                            : zodiacMeaning[insights?.summary_json?.chinese_zodiac ?? ""]) ||
                          tr(
                            "Ditt årsdjur baseras på ditt födelseår och speglar arketypiska drag i kinesisk tradition.",
                            "Your year animal is based on your birth year and reflects archetypal traits in Chinese tradition."
                          )
                        } ${tr(
                          "Det visar sig ofta både i ditt naturliga temperament och i hur du rör dig i sociala sammanhang. När det är starkt märks det i din instinkt under press eller i nya situationer.",
                          "It often shows up as both your natural temperament and how you move through community. When it’s strong, you’ll notice it as your instinctive style under pressure or in new situations."
                        )}\n\n${
                          zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""] ?
                            `${tr("Djur", "Animal")}: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.animalChar}\n${tr("Jordisk gren", "Earthly Branch")}: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.earthlyBranch}\n${tr("Trigon", "Trine")}: ${localizeZodiacTrine(zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.trine)} ${tr("(en grupp av tre djur med liknande rytm och element)", "(a group of three animals that share a similar rhythm and element)")}` :
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
                      <p className="summary-label">{tr("Årsdjur", "Year animal")}</p>
                      <p className="summary-value">
                        {localizeZodiacAnimal(insights?.summary_json?.chinese_zodiac ?? null) || "–"}
                      </p>
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
                          `${tr("Yin/Yang beskriver djurets polaritet.", "Yin/Yang describes the polarity of the animal.")}\n\nYin/Yang: ${localizeZodiacYinYang(zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.yinYang)}\n${tr(
                            "Yin tenderar att vara mottagande och reflekterande; Yang tenderar att vara uttrycksfullt och utåtriktat. Polariteten påverkar tempo, relationer och hur du bearbetar upplevelser.",
                            "Yin tends to be receptive and reflective; Yang tends to be expressive and outward. This polarity colors how you pace yourself, relate to others, and process experiences."
                          )}`,
                          undefined,
                          undefined,
                          "☯︎"
                        )
                      }
                    >
                        <span className="summary-icon zodiac-icon">☯︎</span>
                        <div>
                          <p className="summary-label">{tr("Yin/Yang", "Yin/Yang")}</p>
                          <p className="summary-value">
                            {localizeZodiacYinYang(zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.yinYang)}
                          </p>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="summary-item zodiac-row-button"
                        onClick={() =>
                        openModal(
                          tr("Element", "Element"),
                          `${tr("Det fasta elementet ger djuret en djupare ton.", "The fixed element adds a deeper tone to the animal.")}\n\n${tr("Element", "Element")}: ${localizeZodiacElement(zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.element)}\n${tr(
                            "Elementet färgar dina styrkor, utmaningar och hur du reagerar under press.",
                            "This element colors your strengths, challenges, and how you respond under pressure."
                          )}`,
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
                          <p className="summary-label">{tr("Element", "Element")}</p>
                          <p className="summary-value">
                            {localizeZodiacElement(zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.element)}
                          </p>
                        </div>
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <div className="summary-card tarot-profile-card">
            <h3>{tr("Tarot · Dagens kort", "Tarot · Daily Card")}</h3>
            {tarotDaily ? (
              <div className="tarot-daily-mini">
                {tarotDaily.imageUrl ? (
                  <button
                    type="button"
                    className="tarot-card-open-btn tarot-card-preview tarot-card-focus-btn"
                    onClick={openTarotCardModal}
                    aria-label={tr(`Öppna full tolkning för ${tarotDaily.cardName}`, `Open full reading for ${tarotDaily.cardName}`)}
                    title={tr("Öppna full tolkning", "Open full reading")}
                  >
                    <img className="tarot-card-image tarot-card-image-focus" src={tarotDaily.imageUrl} alt={tarotDaily.cardName} loading="lazy" />
                    <span className="tarot-card-hint">{tr("Tryck för full tolkning", "Tap for full reading")}</span>
                  </button>
                ) : null}
                <div className="tarot-daily-copy">
                  <p className="tarot-card-name">
                    {tarotDaily.cardName}
                    <span> ({tarotDaily.orientation === "upright" ? tr("upprätt", "upright") : tr("omvänt", "reversed")})</span>
                  </p>
                  <p className="summary-detail">{tarotDaily.summary}</p>
                </div>
              </div>
            ) : (
              <p className="summary-detail">{tarotLoading ? tr("Laddar dagens kort...", "Loading daily card...") : tr("Dagens kort visas här.", "Daily card will appear here.")}</p>
            )}
            {tarotStatus ? <p className="summary-detail">{tarotStatus}</p> : null}
            <a className="btn-link" href="/tarot/oracle">
              {tr("Öppna tarot", "Open Tarot")}
            </a>
          </div>

        <div className="insights-actions">
          {insights ? (
            <>
              <a className="btn-primary" href={superReportUrl} target="_blank" rel="noreferrer">
                {tr("Generera full_natalanalysrapport", "Generate full_natalanalysrapport")}
              </a>
              <a className="btn-ghost" href={superReportPrintUrl} target="_blank" rel="noreferrer">
                {tr("Öppna utskriftsläge", "Open print mode")}
              </a>
            </>
          ) : (
            <span className="status">{tr("Spara profil för att skapa rapport.", "Save profile to generate report.")}</span>
          )}
          {insightsError ? <span className="status bad">{insightsError}</span> : null}
        </div>
      </section>
          ) : null}

      {!profileMissing ? (
      <section className="profile-card astro-chart">
        <p className="eyebrow">{tr("Astrologi", "Astrology")}</p>
        <div className="summary-card deep-dive-astro">
          <h3>{tr("Gå djupare", "Go Deeper")}</h3>
          <p className="summary-detail">
            {tr(
              "Din karta beräknas från födelsedatum, exakt tid och plats för att placera varje planet i ett tecken och ett hus. Tänk på den som en lagerkarta: planeterna är aktörerna, tecknen deras stil och husen scenerna där berättelsen utspelas i verkliga livet.",
              "Your chart is calculated from birth date, exact time, and location to place each planet in a sign and a house. Think of it as a layered map: planets are the actors, signs are their style, and houses are the stages where the story unfolds in real life."
            )}
          </p>
          <p className="summary-detail">
            {tr(
              "Hus- och planetöversikten nedan visar var din energi koncentreras. Tryck på en placering för djupare betydelse: planetens driv, tecknets ton och husets livsområde. Aspekter är samtalen mellan planeterna: enkla vinklar känns naturliga, spända skapar friktion som driver utveckling.",
              "The Houses & Planets chart below shows where your energy concentrates. Tap a placement to see the deeper meaning: the planet’s drive, the sign’s tone, and the house’s life area. Aspects are the conversations between planets—easy angles feel natural, tense ones create friction that drives growth. Together, these layers reveal your patterns, your strengths, and the kinds of situations that shape you most."
            )}
          </p>
        </div>
        <div className="chart-wrap">
          <div className="house-chart">
            <div className="house-chart-header">
              <span>{tr("Tecken", "Signs")}</span>
              <span className="planet-header">{tr("Planeter", "Planets")}</span>
              <span>{tr("Hus", "House")}</span>
            </div>
            {houseRows.map((row) => (
              <div key={`house-${row.house}`} className="house-chart-row">
                <div className="house-cell house-cell-sign">
                  <button
                    type="button"
                    className="house-sign"
                    onClick={() =>
                      openModal(
                        localizeSignName(row.sign ?? null) || tr("Tecken", "Sign"),
                        (() => {
                          const signText = describeSignDeep(row.sign);
                          const list = [
                            row.ascendant ? tr("Ascendent", "Ascendant") : null,
                            ...row.planets.map((p) => localizePlanetName(p.name)),
                          ].filter(Boolean);
                          const signName = localizeSignName(row.sign ?? null) || row.sign;
                          const planetText = list.length
                            ? tr(
                                `I din karta har ${signName} ${list.join(", ")}.`,
                                `In your chart, ${signName} hosts ${list.join(", ")}.`
                              )
                            : tr(
                                `I din karta har ${signName} inga planeter.`,
                                `In your chart, ${signName} doesn’t host any planets.`
                              );
                          const houseText = row.house
                            ? tr(
                                `Det här tecknet ligger i ${houseLabel(row.house)}.`,
                                `This sign sits in the ${houseLabel(row.house)}.`
                              )
                            : "";
                          return `${signText} ${planetText} ${houseText}`.trim();
                        })(),
                        houseLabel(row.house),
                        undefined,
                        row.signSymbol
                      )
                    }
                  >
                    <span className="sign-symbol">{row.signSymbol}</span>
                    <span>{localizeSignName(row.sign ?? null) || "–"}</span>
                  </button>
                </div>
                <div className="house-planets">
                  {row.ascendant ? (
                    <button
                      type="button"
                      className="planet-line"
                      onClick={() =>
                        openModal(
                          tr("Ascendent", "Ascendant"),
                          (() => {
                            const base = describeAscendantDeep(row.sign);
                            const houseText = tr(
                              `Den förankrar ${houseLabel(1)} - området för ${houseDetailText(1)}.`,
                              `It anchors the ${houseLabel(1)} — the area of ${houseDetailText(1)}.`
                            );
                            const signText = row.sign
                              ? tr(
                                  `I ${localizeSignName(row.sign)} färgar den ditt första intryck och din närvaro.`,
                                  `In ${localizeSignName(row.sign)}, it comes across as ${signTone[row.sign] ?? "a distinct personal style"}.`
                                )
                              : "";
                            return `${base} ${houseText} ${signText}`.trim();
                          })(),
                          ascLon
                            ? `${localizeSignName(row.sign ?? null) || "–"}, ${formatDegree(ascLon)} · ${houseLabel(1)}`
                            : undefined,
                          undefined,
                          "↥"
                        )
                      }
                    >
                      <span className="planet-symbol">↥</span>
                      <span>{tr("Ascendent", "Ascendant")}</span>
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
                            localizePlanetName(p.name),
                            (() => {
                              const planetText =
                                (isSwedish
                                  ? planetMeaningSv[p.name] ?? "Den här planeten beskriver ett livstema."
                                  : planetMeaning[p.name] ?? "This planet describes a life theme.");
                              const houseText = row.house
                                ? tr(
                                    `Den ligger i ${houseLabel(row.house)} - området för ${houseDetailText(row.house)}.`,
                                    `It lives in the ${houseLabel(row.house)} — the area of ${houseDetailText(row.house)}.`
                                  )
                                : "";
                              const sign = p.sign || row.sign;
                              const signText = sign
                                ? tr(
                                    `I ${localizeSignName(sign)} färgas uttrycket av tecknets ton.`,
                                    `In ${localizeSignName(sign)}, it tends to ${signTone[sign] ?? "express in its own style"}.`
                                  )
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
                        <span>{localizePlanetName(p.name)}</span>
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
                        houseLabel(row.house),
                        (() => {
                          const base = houseMeaningText(row.house);
                          const detail = row.house
                            ? tr(
                                `Det fokuserar på ${houseDetailText(row.house)}`,
                                `It focuses on ${houseDetailText(row.house)}`
                              )
                            : "";
                          const signText = row.sign
                            ? tr(
                                `Tecknet på detta hus är ${localizeSignName(row.sign)}: ${describeSignDeep(row.sign)}`,
                                `The sign on this house is ${localizeSignName(row.sign)}: ${describeSignDeep(row.sign)}`
                              )
                            : "";
                          const list = [
                            row.ascendant ? tr("Ascendent", "Ascendant") : null,
                            ...row.planets.map((p) => localizePlanetName(p.name)),
                          ].filter(Boolean);
                          const planetText = list.length
                            ? tr(`Det rymmer ${list.join(", ")}.`, `It hosts ${list.join(", ")}.`)
                            : tr("Det håller just nu inga planeter.", "It currently holds no planets.");
                          return `${base} ${detail} ${signText} ${planetText}`.trim();
                        })(),
                        houseLabel(row.house),
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
                          <h4>{localizePlanetName(p.name)}</h4>
                          <p>
                            {localizeSignName(p.sign ?? null) || p.sign}, {deg}
                          </p>
                          <div className="detail-meta">
                            <span className="detail-chip">
                              <span className="chip-icon">{signSymbolFor(p.sign ?? null)}</span>
                              {localizeSignName(p.sign ?? null) || "–"}
                            </span>
                            <span className="detail-chip">
                              <span className="chip-icon house-mini">{houseSvgIconSmall}</span>
                              {houseLabel(p.house)}
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
                      <h4>{tr("Ascendent", "Ascendant")}</h4>
                      <p>
                        {localizeSignName(ascSign ?? null) || "–"}, {formatDegree(ascLon)}
                      </p>
                      <div className="detail-meta">
                        <span className="detail-chip">
                          <span className="chip-icon">{signSymbolFor(ascSign ?? null)}</span>
                          {localizeSignName(ascSign ?? null) || "–"}
                        </span>
                        <span className="detail-chip">
                          <span className="chip-icon house-mini">{houseSvgIconSmall}</span>
                          {houseLabel(1)}
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
        <p className="eyebrow">{tr("Deep Dive", "Deep Dive")}</p>
        <div className="summary-stack">
          <section className="hd-card" aria-labelledby="hd-title">
            <h2 id="hd-title">{tr("Deep Dive - Human Design", "Deep Dive - Human Design")}</h2>

            <div className="hd-grid">
              <div className="hd-item">
                <div className="hd-icon">⚡</div>
                <div className="hd-meta">
                  <div className="hd-label">{tr("Energityp", "Energy Type")}</div>
                  <div className="hd-value">{hdTypeLabel}</div>
                </div>
              </div>

              <div className="hd-item">
                <div className="hd-icon">↳</div>
                <div className="hd-meta">
                  <div className="hd-label">{tr("Strategi", "Strategy")}</div>
                  <div className="hd-value">{hdStrategyLabel}</div>
                </div>
              </div>

              <div className="hd-item">
                <div className="hd-icon">◎</div>
                <div className="hd-meta">
                  <div className="hd-label">{tr("Auktoritet", "Authority")}</div>
                  <div className="hd-value">{hdAuthorityLabel}</div>
                </div>
              </div>

              <div className="hd-item">
                <div className="hd-icon">◈</div>
                <div className="hd-meta">
                  <div className="hd-label">{tr("Profil", "Profile")}</div>
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
                {tr("Om Human Design", "About Human Design")}
                <span className={`hd-btn-caret${isHdOpen ? " open" : ""}`} aria-hidden="true">
                  ▾
                </span>
              </button>
              <button
                className="hd-btn hd-btn-primary"
                type="button"
                onClick={() => setIsHdChartOpen(true)}
              >
                {tr("Skapa chart", "Create Chart")}
              </button>
            </div>

            <div className="hd-deeper" id="hd-deeper" hidden={!isHdOpen}>
              <h3>{hdDeepDiveTitle}</h3>

              <div className="hd-chartwrap">
                <div className="hd-charthead">
                  <div>
                    <div className="hd-charttitle">{tr("Bodygraf", "Bodygraph")}</div>
                    <div className="hd-chartsub">
                      {tr(
                        "Definierade center och kanaler markerade från födelsedatan.",
                        "Defined centers and channels marked from birth data."
                      )}
                    </div>
                  </div>
                </div>
                <div className="hd-bodygraph-wrap" aria-label={tr("Human Design bodygraf", "Human Design bodygraph")}>
                  {renderHdBodygraph()}
                </div>
              </div>

              {isEmotionalAuthority ? (
                <div className="hd-chartwrap" role="group" aria-label={tr("Diagram för emotionell auktoritetsvåg", "Emotional Authority Wave chart")}>
                  <div className="hd-charthead">
                    <div>
                      <div className="hd-charttitle">{tr("Emotionell auktoritetsvåg", "Emotional Authority Wave")}</div>
                      <div className="hd-chartsub">
                        {tr(
                          "Klarhet tenderar att komma efter toppen/dalen, inte i första impulsen.",
                          "Clarity tends to come after the wave peak/valley, not in the first impulse."
                        )}
                      </div>
                    </div>
                    <button className="hd-mini" type="button" onClick={drawHdWave}>
                      {tr("Rita om", "Redraw")}
                    </button>
                  </div>

                  <canvas
                    ref={hdCanvasRef}
                    className="hd-canvas"
                    height={220}
                    aria-label={tr("Vågdiagram", "Wave chart")}
                  />

                  <div className="hd-chartlegend" aria-hidden="true">
                    <span className="pill">{tr("Hög", "High")}</span>
                    <span className="pill">{tr("Neutral / klarhetszon", "Neutral / clarity zone")}</span>
                    <span className="pill">{tr("Låg", "Low")}</span>
                  </div>

                  <p className="hd-note">
                    {tr(
                      "Tips: använd detta som beslutshygien. Vänta minst en natt (ibland 2-3 dygn) och känn om ditt ja/nej är stabilt över flera lägen.",
                      "Tip: use this as decision hygiene. Wait at least one night (sometimes 2-3 days) and check if your yes/no is stable across states."
                    )}
                  </p>
                </div>
              ) : (
                <div className="hd-chartwrap" role="group" aria-label={tr("Auktoritetsfokus", "Authority focus")}>
                  <div className="hd-charthead">
                    <div>
                      <div className="hd-charttitle">
                        {hdAuthority !== "–"
                          ? tr(`${hdAuthorityLabel} fokus`, `${hdAuthority} focus`)
                          : tr("Auktoritetsfokus", "Authority focus")}
                      </div>
                      <div className="hd-chartsub">
                        {authorityDetail ||
                          tr(
                            "Auktoritet visar var din mest tillförlitliga inre kompass finns.",
                            "Authority shows where your most reliable inner compass lives."
                          )}
                      </div>
                    </div>
                  </div>
                  <p className="hd-note">
                    {tr(
                      "Tips: ge beslut tid och låt kroppen bekräfta över flera lägen.",
                      "Tip: give decisions time and let your body confirm across multiple states."
                    )}
                  </p>
                </div>
              )}

              <div className="hd-section">
                <h4>{hdType !== "–" ? `${hdTypeLabel} (${tr("kort men nördigt", "short but nerdy")})` : tr("Energityp (kort men nördigt)", "Energy Type (short but nerdy)")}</h4>
                <ul>
                  <li>
                    <strong>{tr("Signatur", "Signature")}:</strong> {typeSignatureLabel || typeSignature || "—"}{" "}
                    <strong>{tr("Inte-jag", "Not-self")}:</strong> {typeNotSelfLabel || typeNotSelf || "—"}.
                  </li>
                  <li>
                    <strong>{tr("Strategi i praktiken", "Strategy in practice")}:</strong>{" "}
                    {strategyDetail || tr("Strategi är din praktiska väg till mindre friktion.", "Strategy is your practical path to less friction.")}
                  </li>
                </ul>
              </div>

              <div className="hd-section">
                <h4>{hdProfile !== "–" ? `${tr("Profil", "Profile")} ${hdProfileLabel}` : tr("Profil", "Profile")}</h4>
                <ul>
                  <li>
                    <strong>{tr("Profiltext", "Profile text")}:</strong>{" "}
                    {profileDetail || tr("Profilen beskriver hur du lär, relaterar och mognar över tid.", "Profile describes how you learn, relate, and mature over time.")}
                  </li>
                  <li>{profileExample || tr("Exempel: Din profil visar hur relationer och erfarenheter formar din roll.", "Example: Your profile shows how relationships and experience shape your role.")}</li>
                </ul>
              </div>

              <div className="hd-section">
                <h4>{hdDefinition !== "–" ? `${hdDefinitionLabel} (${tr("nördnotis", "nerd note")})` : tr("Definition (nördnotis)", "Definition (nerd note)")}</h4>
                <ul>
                  {isSplitDefinition ? (
                    <>
                      <li>
                        {tr(
                          "Två öar i din definition som gärna kopplas ihop via rätt personer och miljöer (bridging).",
                          "Two islands in your definition that often connect through the right people and environments (bridging)."
                        )}
                      </li>
                      <li>
                        {tr(
                          "När den bryggas: aha, nu sitter allt, ofta tydligt i samarbete.",
                          "When it bridges: things click, often most visible in collaboration."
                        )}
                      </li>
                    </>
                  ) : (
                    <>
                      <li>
                        {hdDefinition !== "–"
                          ? tr(
                              `Din definition är ${hdDefinitionLabel}. Den beskriver hur dina center hänger ihop och hur du processar information.`,
                              `Your definition is ${hdDefinition}. It describes how your centers connect and how you process information.`
                            )
                          : tr(
                              "Din definition beskriver hur dina center hänger ihop och hur du processar information.",
                              "Your definition describes how your centers connect and how you process information."
                            )}
                      </li>
                      <li>
                        {tr(
                          "Rätt miljö och samarbete kan göra att allt faller på plats snabbare.",
                          "The right environment and collaboration can help things fall into place faster."
                        )}
                      </li>
                    </>
                  )}
                </ul>
              </div>
            </div>
          </section>

              <div className="summary-card zodiac-card">
            <h3>{tr("Deep Dive - Kinesisk zodiak", "Deep Dive - Chinese Zodiac")}</h3>
            <div className="summary-items">
              <div className="zodiac-stack">
                <button
                  type="button"
                  className="summary-item zodiac-row-button"
                  onClick={() =>
                    openModal(
                      tr("Årsdjur", "Year animal"),
                      `${
                        (isSwedish
                          ? ZODIAC_MEANING_SV[insights?.summary_json?.chinese_zodiac ?? ""]
                          : zodiacMeaning[insights?.summary_json?.chinese_zodiac ?? ""]) ||
                        tr(
                          "Ditt årsdjur baseras på ditt födelseår och speglar arketypiska drag i kinesisk tradition.",
                          "Your year animal is based on your birth year and reflects archetypal traits in Chinese tradition."
                        )
                      } ${tr(
                        "Det visar sig ofta både i ditt naturliga temperament och i hur du rör dig i sociala sammanhang. När det är starkt märks det i din instinkt under press eller i nya situationer.",
                        "It often shows up as both your natural temperament and how you move through community. When it is strong, you notice it as your instinctive style under pressure or in new situations."
                      )}\n\n${
                        zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""] ?
                          `${tr("Djur", "Animal")}: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.animalChar}\n${tr("Jordisk gren", "Earthly Branch")}: ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.earthlyBranch}\n${tr("Trigon", "Trine")}: ${localizeZodiacTrine(zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.trine)} ${tr("(en grupp av tre djur med liknande rytm och element)", "(a group of three animals that share a similar rhythm and element)")}` :
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
                    <p className="summary-label">{tr("Årsdjur", "Year animal")}</p>
                    <p className="summary-value">
                      {localizeZodiacAnimal(insights?.summary_json?.chinese_zodiac ?? null) || "–"}
                    </p>
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
                        `${tr("Yin/Yang beskriver djurets polaritet.", "Yin/Yang describes the polarity of the animal.")}\n\nYin/Yang: ${localizeZodiacYinYang(zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.yinYang)}\n${tr(
                          "Yin tenderar att vara mottagande och reflekterande; Yang tenderar att vara uttrycksfullt och utåtriktat. Polariteten påverkar tempo, relationer och hur du bearbetar upplevelser.",
                          "Yin tends to be receptive and reflective; Yang tends to be expressive and outward. This polarity colors how you pace yourself, relate to others, and process experiences."
                        )}`,
                        undefined,
                        undefined,
                        "☯︎"
                      )
                    }
                  >
                      <span className="summary-icon zodiac-icon">☯︎</span>
                      <div>
                          <p className="summary-label">{tr("Yin/Yang", "Yin/Yang")}</p>
                        <p className="summary-value">
                          {localizeZodiacYinYang(zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.yinYang)}
                        </p>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="summary-item zodiac-row-button"
                      onClick={() =>
                      openModal(
                        tr("Element", "Element"),
                        `${tr("Det fasta elementet ger djuret en djupare ton.", "The fixed element adds a deeper tone to the animal.")}\n\n${tr("Element", "Element")}: ${localizeZodiacElement(zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.element)}\n${tr(
                          "Elementet färgar dina styrkor, utmaningar och hur du reagerar under press.",
                          "This element colors your strengths, challenges, and how you respond under pressure."
                        )}`,
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
                          <p className="summary-label">{tr("Element", "Element")}</p>
                        <p className="summary-value">
                          {localizeZodiacElement(zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.element)}
                        </p>
                      </div>
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            <p className="summary-detail">
              {insights?.summary_json?.chinese_zodiac
                ? tr(
                    `${localizeZodiacAnimal(insights?.summary_json?.chinese_zodiac ?? null)} är årsdjuret kopplat till ditt födelseår. Det ger en bred lins på temperament, social rytm och hur du rör dig genom förändring.`,
                    `${insights?.summary_json?.chinese_zodiac} is the year animal tied to your birth year. It offers a broad lens on temperament, social rhythm, and how you move through change.`
                  )
                : tr(
                    "Ditt årsdjur ger en bred lins på temperament och hur du rör dig genom förändring.",
                    "Your year animal offers a broad lens on temperament and how you move through change."
                  )}{" "}
              {zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]?.element
                ? tr(
                    `${(localizeZodiacElement(zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.element) || "").toLowerCase()}-elementet lägger till en stadig underton som färgar dina styrkor och utmaningar.`,
                    `The ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.element.toLowerCase()} element adds a steady undertone that colors your strengths and challenges.`
                  )
                : ""}{" "}
              {zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]?.yinYang
                ? tr(
                    `${(localizeZodiacYinYang(zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.yinYang) || "").toLowerCase()}-polariteten visar om din energi oftare är mer mottagande eller uttrycksfull i vardagen.`,
                    `The ${zodiacMeta[insights?.summary_json?.chinese_zodiac ?? ""]!.yinYang.toLowerCase()} polarity hints at whether your energy tends to be more receptive or expressive in daily life.`
                  )
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
              <p className="eyebrow">{tr("Human Design", "Human Design")}</p>
              <h2>{tr("Human Design-rapport", "Human Design Report")}</h2>
              <p className="lead">
                {tr(
                  "En tydlig sammanställning av din chart med bodygraf, gates, channels och center.",
                  "A clear summary of your chart with bodygraph, gates, channels, and centers."
                )}
              </p>
            </div>
          </div>

          {hdPageLoading ? <p>{tr("Laddar rapport...", "Loading report...")}</p> : null}
          {hdPageError ? <p className="status bad">{hdPageError}</p> : null}

          {!hdPageLoading && !hdPageError ? (
            <>
              <iframe
                className="hd-report-frame"
                title={tr("Human Design-rapport", "Human Design Report")}
                src={hdReportUrl}
              />
              <div className="modal-actions hd-modal-actions">
                <a className="btn-primary" href={hdReportPrintUrl} target="_blank" rel="noreferrer">
                  {tr("Ladda ner rapport (PDF)", "Download report (PDF)")}
                </a>
                <a className="btn-ghost" href={hdEmailLink}>
                  {tr("Skicka till min e-post", "Send to my email")}
                </a>
                {superReportInsights ? (
                  <>
                    <a className="btn-primary" href={superReportUrl} target="_blank" rel="noreferrer">
                      {tr("Generera full_natalanalysrapport", "Generate full_natalanalysrapport")}
                    </a>
                    <a className="btn-ghost" href={superReportPrintUrl} target="_blank" rel="noreferrer">
                      {tr("Öppna full_natalanalysrapport (utskrift)", "Open full_natalanalysrapport (print)")}
                    </a>
                  </>
                ) : (
                  <span className="status">
                    {tr(
                      "Full_natalanalysrapport blir tillgänglig när profildata är laddad.",
                      "Full_natalanalysrapport will be available when profile data is loaded."
                    )}
                  </span>
                )}
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {isTarotPage ? (
        <section className="madame-cinema" aria-label={tr("Madame Floods tarotkammare", "Madame Flood tarot chamber")}>
          <div className="madame-vignette" aria-hidden="true" />
          <div className="madame-film">
            <header className="madame-intro">
              {!introImageMissing ? (
                <img
                  src="/tarot/tarot-introduction.png"
                  alt={tr("Madame Flood tarotintroduktion", "Madame Flood tarot introduction")}
                  className="madame-intro-image"
                  onError={() => setIntroImageMissing(true)}
                />
              ) : (
                <div className="madame-intro-fallback">Madame Flood</div>
              )}
              <div className="madame-intro-copy">
                <p className="madame-name">Madame Flood</p>
                <h1>{tr("Jag är Madame Flood.", "I am Madame Flood.")}</h1>
                <p className="lead">
                  {tr(
                    "Sitt med mig i mörkret och håll en kärlekshistoria i ditt sinne. Jag guidar dig, ett kort i taget.",
                    "Sit with me in the dark and hold one love story in your mind. I will guide you, one card at a time."
                  )}
                </p>
                <p className="summary-detail">
                  {tarotDaily
                    ? tarotDrawCreated
                      ? tr("Jag har just dragit ditt dagliga kort och förseglat det i din profil.", "I have just drawn your daily card and sealed it in your profile.")
                      : tr("Ditt dagliga kort var redan draget idag och återställdes från din profil.", "Your daily card was already drawn today and restored from your profile.")
                    : tarotLoading
                      ? tr("Jag förbereder bordet åt dig.", "I am preparing the table for you.")
                      : tr("Bordet väntar på din första fråga.", "The table is waiting for your first question.")}
                </p>
                {tarotStatus ? <p className="summary-detail">{tarotStatus}</p> : null}
              </div>
            </header>

            <article className="summary-card tarot-oracle-card madame-panel">
              <div className="tarot-oracle-controls">
                <div className="tarot-oracle-buttons">
                  <button className="btn-primary" type="button" onClick={startOracleSession}>
                    {tr("Gå in i Madame Floods session", "Enter Madame Flood's session")}
                  </button>
                  <button
                    className="btn-ghost"
                    type="button"
                    onClick={() => setOracleVoiceEnabled((prev) => !prev)}
                  >
                    {tr("Röst", "Voice")} {oracleVoiceEnabled ? tr("På", "On") : tr("Av", "Off")}
                  </button>
                </div>
                <div className="tarot-oracle-preferences">
                  <label className="tarot-pref">
                    <span>{tr("Språk", "Language")}</span>
                    <select
                      className="input"
                      value={oracleLanguage}
                      onChange={(e) => setOracleLanguage(e.target.value)}
                    >
                      {ORACLE_LANGUAGES.map((lang) => (
                        <option key={lang.code} value={lang.code}>
                          {lang.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="tarot-pref">
                    <span>{tr("Röst", "Voice")}</span>
                    <select
                      className="input"
                      value={selectedOracleVoice}
                      onChange={(e) => setSelectedOracleVoice(e.target.value)}
                    >
                      {oracleVoices.length === 0 ? (
                        <option value="">{tr("Systemstandard", "System default")}</option>
                      ) : (
                        oracleVoices.map((voice) => (
                          <option key={`${voice.lang}-${voice.name}`} value={voice.name}>
                            {voice.name} ({voice.lang})
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                </div>
              </div>

              {loveReadingStage === "intro" ? (
                <div className="tarot-cinematic-intro madame-cinematic-intro">
                  <p className="summary-detail">
                    {tr(
                      "I den här kammaren är det bara du och jag. När du börjar frågar jag vilken kärleksläggning du söker.",
                      "In this chamber, you and I are alone. When you begin, I will ask what kind of love reading you seek."
                    )}
                  </p>
                </div>
              ) : null}

              {oracleSessionStarted ? (
                <div className="tarot-oracle-chat">
                  <div className="tarot-oracle-log">
                    {oracleMessages.map((msg, idx) => (
                      <p key={`oracle-msg-${idx}`} className={`tarot-oracle-line ${msg.role === "oracle" ? "oracle" : "user"}`}>
                        <strong>{msg.role === "oracle" ? "Madame Flood:" : tr("Du:", "You:")}</strong> {msg.text}
                      </p>
                    ))}
                  </div>
                  <p className="summary-detail tarot-oracle-current">
                    {oracleAiLoading
                      ? tr("Madame Flood kanaliserar din läsning...", "Madame Flood is channeling your reading...")
                      : tr(
                          "Välj ett alternativ eller svara med röst när alternativ visas.",
                          "Choose an option or reply by voice when options are visible."
                        )}
                  </p>
                  <div className="tarot-oracle-inputs">
                    <button
                      className="btn-primary"
                      type="button"
                      onClick={startOracleListening}
                      disabled={oracleListening || oracleAiLoading}
                    >
                      {oracleListening ? tr("Lyssnar...", "Listening...") : tr("Svara med min röst", "Answer with my voice")}
                    </button>
                  </div>
                  {oracleVoiceTranscript ? (
                    <p className="summary-detail tarot-oracle-current">
                      {tr("Senaste röstsvar", "Latest voice response")}: "{oracleVoiceTranscript}"
                    </p>
                  ) : null}
                </div>
              ) : null}

              {loveReadingStage === "choice" ? (
                <div className="tarot-choice-grid">
                  {loveFocusOptions.map((option) => (
                    <button
                      key={`focus-option-${option}`}
                      className="btn-ghost"
                      type="button"
                      onClick={() => chooseLoveReadingFocus(option)}
                      disabled={oracleAiLoading}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}

              {loveReadingStage === "preparation" ? (
                <div className="tarot-cinematic-intro">
                  <p className="summary-detail">{activeGuidedQuestion}</p>
                  <div className="tarot-choice-grid">
                    {activeOracleOptions.map((option) => (
                      <button
                        key={`guided-option-${option}`}
                        className="btn-ghost"
                        type="button"
                        onClick={() => chooseGuidedQuestionOption(option)}
                        disabled={oracleAiLoading || tarotDealing}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div
                className={`tarot-reading-stage love-reading-board ${tarotDealing ? "dealing" : ""} ${
                  loveReadingStage === "intro" || loveReadingStage === "choice" || loveReadingStage === "preparation"
                    ? "is-folded"
                    : "is-open"
                }`}
              >
                <div className={`tarot-shuffle-stack ${tarotShuffleActive ? "active" : ""}`} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="tarot-reading-grid">
                  {tarotReadingCards.map((entry, idx) => (
                    <button
                      key={`${entry.slot}-${entry.card.number}-${idx}`}
                      type="button"
                      className={`tarot-reading-card ${entry.placed ? "placed" : "unplaced"} ${entry.revealed ? "revealed" : ""} ${entry.orientation === "reversed" ? "is-reversed" : "is-upright"} ${
                        activeLoveCardIndex === idx ? "is-active-turn" : ""
                      }`}
                      onClick={() => openFocusedReadingCard(idx)}
                      disabled={!entry.placed}
                    >
                      <div className="tarot-reading-card-inner">
                        <div className="tarot-reading-card-face tarot-reading-card-back">
                          <span>✦</span>
                        </div>
                        <div className="tarot-reading-card-face tarot-reading-card-front">
                          <p className="tarot-reading-slot">{entry.slot}</p>
                          <img src={entry.card.imageUrl} alt={`${entry.card.name} tarot card`} loading="lazy" />
                          <p className="tarot-reading-name">
                            {entry.card.name} <span>({entry.orientation === "upright" ? tr("upprätt", "upright") : tr("omvänt", "reversed")})</span>
                          </p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {loveReadingStage === "clarify_offer" ? (
                <div className="tarot-reading-actions">
                  <button className="btn-primary" type="button" onClick={() => offerClarifyingCard(true)}>
                    {tr("Ja, lägg ett förtydligande kort", "Yes, deal one clarifying card")}
                  </button>
                  <button className="btn-ghost" type="button" onClick={() => offerClarifyingCard(false)}>
                    {tr("Nej, avsluta läsningen", "No, close the reading")}
                  </button>
                </div>
              ) : null}

              {(loveReadingStage === "done" || tarotReadingSummary) ? (
                <div className="tarot-reading-summary">
                  <h4>{tr("Madame Floods tolkning", "Madame Flood's interpretation")}</h4>
                  <p className="summary-detail">{tarotReadingSummary || tr("Din tolkning visas här.", "Your interpretation will appear here.")}</p>
                </div>
              ) : null}

              {tarotDeckLoading ? <span className="status">{tr("Laddar tarotleken...", "Loading tarot deck...")}</span> : null}
              {tarotDeckError ? <span className="status bad">{tarotDeckError}</span> : null}
              {oracleStatus ? <span className="status">{oracleStatus}</span> : null}
            </article>
          </div>
        </section>
      ) : null}

      {focusedReadingCard ? (
        <div className="tarot-card-viewer-backdrop" onClick={closeFocusedReadingCard}>
          <div className="tarot-card-viewer" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="tarot-viewer-close" onClick={closeFocusedReadingCard}>
              {tr("Tillbaka till bordet", "Return to table")}
            </button>
            <div
              className={`tarot-card-viewer-inner ${focusedReadingCardFlipped ? "flipped" : ""} ${
                focusedReadingCard.card.orientation === "reversed" ? "is-reversed" : "is-upright"
              }`}
            >
              <div className="tarot-card-viewer-face tarot-card-viewer-back">
                <span>✦</span>
              </div>
              <div className="tarot-card-viewer-face tarot-card-viewer-front">
                <img
                  src={focusedReadingCard.card.card.imageUrl}
                  alt={`${focusedReadingCard.card.card.name} tarot card`}
                  loading="lazy"
                />
                <p className="tarot-card-viewer-title">
                  {focusedReadingCard.card.card.name}{" "}
                  <span>
                    ({focusedReadingCard.card.orientation === "upright" ? tr("upprätt", "upright") : tr("omvänt", "reversed")})
                  </span>
                </p>
              </div>
            </div>
            <p className="summary-detail tarot-viewer-note">
              {focusedReadingCard.card.slot}
            </p>
          </div>
        </div>
      ) : null}

      {isSettingsPage ? (
        <section className="profile-card background-card">
          <div className="profile-header">
            <div>
              <p className="eyebrow">{tr("Inställningar", "Settings")}</p>
              <h2>{tr("Inställningar", "Settings")}</h2>
            </div>
            <div className="profile-badge">
              <span>{profileMissing ? tr("Saknas", "Missing") : tr("Redo", "Ready")}</span>
            </div>
          </div>

          <div className="background-grid">
            <article className="background-block">
              <h3>{tr("Födelsedata", "Birth data")}</h3>
              <p><strong>{tr("Födelsedatum", "Date of birth")}:</strong> {profileInfo?.birth_date ?? "—"}</p>
              <p>
                <strong>{tr("Födelsetid", "Time of birth")}:</strong>{" "}
                {profileInfo?.birth_time ?? "—"}
                {profileInfo?.tz_name ? ` ${profileInfo.tz_name}` : ""}
              </p>
              <p><strong>{tr("UTC-offset", "UTC offset")}:</strong> {formatUtcOffset(profileInfo?.tz_offset_minutes ?? null)}</p>
              <p><strong>{tr("Födelseort", "City of birth")}:</strong> {profileInfo?.birth_place ?? "—"}</p>
              <p><strong>{tr("Longitud", "Longitude")}:</strong> {profileInfo?.birth_lng ?? "—"}</p>
              <p><strong>{tr("Latitud", "Latitude")}:</strong> {profileInfo?.birth_lat ?? "—"}</p>
              <button className="btn-ghost" onClick={() => setShowEditForm((v) => !v)}>
                {showEditForm ? tr("Stäng", "Close") : tr("Redigera profil", "Edit profile")}
              </button>
            </article>
          </div>

          <div className="profile-actions">
            {superReportInsights ? (
              <>
                <a className="btn-primary" href={superReportUrl} target="_blank" rel="noreferrer">
                  {tr("Generera full_natalanalysrapport", "Generate full_natalanalysrapport")}
                </a>
                <a className="btn-ghost" href={superReportPrintUrl} target="_blank" rel="noreferrer">
                  {tr("Öppna full_natalanalysrapport (utskrift)", "Open full_natalanalysrapport (print)")}
                </a>
              </>
            ) : (
              <span className="status">
                {tr(
                  "Full_natalanalysrapport blir tillgänglig när profildata är laddad.",
                  "Full_natalanalysrapport will be available when profile data is loaded."
                )}
              </span>
            )}
          </div>

          {showEditForm ? (
            <section className="profile-card">
        <div className="profile-header">
          <div>
            <p className="eyebrow">{tr("Redigera", "Edit")}</p>
            <h2>{tr("Uppdatera din födelsedata", "Update your birth data")}</h2>
            <p className="lead">
              {tr("Uppdatera dina uppgifter och beräkna om din profil.", "Update your details and re‑calculate your profile.")}
            </p>
        </div>
        <div className="profile-badge">
            <span>{profileDirty ? tr("Ändringar", "Changes") : tr("Redo", "Ready")}</span>
        </div>
        </div>

        <div className="profile-grid">
          <div className="profile-field">
            <label>{tr("Födelsedatum", "Date of birth")}</label>
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
            <p className="help-text">{tr("Format: ÅÅÅÅ-MM-DD", "Format: YYYY-MM-DD")}</p>
          </div>
          <div className="profile-field">
            <label>{tr("Födelsetid", "Time of birth")}</label>
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
              {tr("Okänd tid", "Unknown time")}
            </label>
          </div>
          <div className="profile-field">
            <label>{tr("Födelseort", "City of birth")}</label>
            <div className="autocomplete">
              <input
                type="text"
                placeholder={tr("Stad, land", "City, country")}
                value={profileForm.birthPlace}
                onChange={(e) => handleProfileChange("birthPlace", e.target.value)}
              />
              {placeLoading ? <div className="autocomplete-status">{tr("Söker…", "Searching…")}</div> : null}
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
                {tr("Ange koordinater", "Enter coordinates")}
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={showMap}
                  onChange={(e) => setShowMap(e.target.checked)}
                />
                {tr("Välj på karta", "Pick on map")}
              </label>
            </div>
          </div>
          {showCoords ? (
            <div className="profile-field">
              <label>{tr("Koordinater", "Coordinates")}</label>
              <div className="coord-row">
                <input
                  type="text"
                  placeholder={tr("Lat", "Lat")}
                  value={profileForm.birthLat}
                  onChange={(e) => handleProfileChange("birthLat", e.target.value)}
                />
                <input
                  type="text"
                  placeholder={tr("Lng", "Lng")}
                  value={profileForm.birthLng}
                  onChange={(e) => handleProfileChange("birthLng", e.target.value)}
                />
              </div>
              <button className="btn-ghost" type="button" onClick={useDeviceLocation}>
                {tr("Använd min plats", "Use my location")}
              </button>
            </div>
          ) : null}
        </div>

        {showMap ? (
          <div className="map-panel">
            <div className="map-header">
              <h3>{tr("Välj en plats", "Pick a location")}</h3>
              <p>{tr("Klicka för att sätta en ungefärlig koordinat.", "Click to set an approximate coordinate.")}</p>
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
            {tr("Spara profil", "Save profile")}
          </button>
          {profileStatus ? <span className="status">{profileStatus}</span> : null}
          {profileError ? <span className="status bad">{profileError}</span> : null}
        </div>
      </section>
          ) : null}

          <div className="background-grid">
            <article className="background-block">
              <h3>{tr("Astrologi", "Astrology")}</h3>
              <p>
                {tr(
                  "Vi använder Swiss Ephemeris (swisseph) för planetpositioner. Du anger datum, tid och plats. Positionerna beräknas i grader i den tropiska zodiaken.",
                  "We use Swiss Ephemeris (swisseph) for planetary positions. You enter date, time, and place. Positions are calculated in degrees of the tropical zodiac."
                )}
              </p>
              <p>
                {tr(
                  "Hus beräknas med Placidus-systemet. Ascendent (AC) och Medium Coeli (MC) kommer från husberäkningen.",
                  "Houses are calculated with the Placidus system. Ascendant (AC) and Midheaven (MC) come from the house calculation."
                )}
              </p>
              <p>
                {tr(
                  "Aspekter (konjunktion, sextil, kvadrat, trigon, opposition) beräknas via vinkelavstånd mellan planeter.",
                  "Aspects (conjunction, sextile, square, trine, opposition) are computed by angular distance between planets."
                )}
              </p>
            </article>

            <article className="background-block">
              <h3>{tr("Tid och tidszon", "Time & timezone")}</h3>
              <p>
                {tr(
                  "Vi använder historisk tidszonsdata (timezone-support) för att beräkna korrekt UTC-offset för exakt datum och plats.",
                  "We use historical timezone data (timezone-support) to calculate the correct UTC offset for your exact date and location."
                )}
              </p>
              <p>
                {tr(
                  "Äldre datum kan skilja sig från appar som tillämpar moderna sommartidsregler retroaktivt. Vi använder historiskt korrekta regler.",
                  "Older dates can differ from apps that apply modern DST rules retroactively. We use historically accurate rules."
                )}
              </p>
            </article>

            <article className="background-block">
              <h3>{tr("Human Design", "Human Design")}</h3>
              <p>
                {tr(
                  "Human Design beräknas med natalengine. Den använder astronomiska positioner (Meeus-algoritmer) för att räkna ut typ, profil, auktoritet, center, gates och kanaler.",
                  "Human Design is calculated with natalengine. It uses astronomical positions (Meeus algorithms) to compute your type, profile, authority, centers, gates, and channels."
                )}
              </p>
              <p>
                {tr(
                  "Resultaten sparas så att din profil laddas direkt nästa gång.",
                  "Results are stored so your profile loads instantly next time."
                )}
              </p>
            </article>

            <article className="background-block">
              <h3>{tr("Kinesisk zodiak", "Chinese zodiac")}</h3>
              <p>
                {tr(
                  "Den kinesiska zodiaken baseras på ditt födelseår och följer en enkel 12-årscykel.",
                  "The Chinese zodiac is based on your birth year and follows a simple 12‑year cycle."
                )}
              </p>
            </article>
          </div>
        </section>
      ) : null}

      {isGamesPage ? (
      <>
        <header className="hero">
        <p className="eyebrow">CHKN</p>
        <h1>{tr("Chicken Race", "Chicken Race")}</h1>
        <p className="lead">
          {tr(
            "Realtidsutmaningar. 5-kamp med Yatzy, Black Jack, Trivia, musikquiz och Texas Hold'em. Servern är domare.",
            "Real-time challenges. Pentathlon with Yatzy, Blackjack, Trivia, music quiz, and Texas Hold'em. The server is the referee."
          )}
        </p>
        <div className="cta-row">
          <button className="btn-primary" onClick={createMatch} disabled={!connected}>
            {tr("Skapa match", "Create match")}
          </button>
          <button className="btn-ghost" onClick={createBlackjackMatch} disabled={!connected}>
            {tr("Spela Black Jack", "Play Blackjack")}
          </button>
          <div className="join-row">
            <input
              className="join-input"
              placeholder={tr("Match-kod", "Match code")}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
            />
            <button className="btn-ghost" onClick={joinMatch} disabled={!connected}>
              {tr("Gå med", "Join")}
            </button>
          </div>
          <button className="btn-ghost" onClick={readyUp} disabled={!matchId}>
            {tr("Redo", "Ready")}
          </button>
        </div>
        {matchMode !== "BLACKJACK_ONLY" ? (
        <div className="import-row">
          <input
            className="join-input"
            placeholder={tr("Yatzy match-id", "Yatzy match id")}
            value={yatzyMatchId}
            onChange={(e) => setYatzyMatchId(e.target.value)}
          />
          <button
            className="btn-ghost"
            onClick={setYatzyMatch}
            disabled={!matchId || !yatzyMatchId.trim() || selfId !== hostUserId}
            title={selfId !== hostUserId ? tr("Endast värd kan sätta match", "Only host can set match") : ""}
          >
            {tr("Sätt Yatzy-match", "Set Yatzy match")}
          </button>
          <button
            className="btn-ghost"
            onClick={createYatzyMatch}
            disabled={!matchId || selfId !== hostUserId}
            title={selfId !== hostUserId ? tr("Endast värd kan skapa match", "Only host can create match") : ""}
          >
            {tr("Skapa Yatzy-match", "Create Yatzy match")}
          </button>
          <button className="btn-ghost" onClick={importYatzy} disabled={!matchId || !yatzyMatchId.trim()}>
            {tr("Importera Yatzy", "Import Yatzy")}
          </button>
          {yatzyImportStatus ? <span className="status">{yatzyImportStatus}</span> : null}
          {yatzyCreateStatus ? <span className="status">{yatzyCreateStatus}</span> : null}
        </div>
        ) : null}
        {yatzyMatchId ? (
          <div className="import-row">
            <a
              className="btn-link"
            href={`${ytzyBase}/#/m/${yatzyMatchId}`}
            target="_blank"
            rel="noreferrer"
          >
              {tr("Öppna Yatzy-match", "Open Yatzy match")}
            </a>
          </div>
        ) : null}
        <div className="status-row">
          <span className={connected ? "status ok" : "status bad"}>
            {connected ? tr("Online", "Online") : tr("Offline", "Offline")}
          </span>
          <span className="status">{matchId ? `${tr("Match", "Match")}: ${matchId}` : tr("Ingen match", "No match")}</span>
          {lastError ? <span className="status bad">{tr("Fel", "Error")}: {lastError}</span> : null}
          <span className="status">{tr("Loggrader", "Log entries")}: {log.length}</span>
          <span className="status">{selfId ? `${tr("Du", "You")}: ${selfId}` : `${tr("Du", "You")}: -`}</span>
          <span className="status">{tr("Fas", "Stage")}: {stage}</span>
          <span className="status">{tr("Värd", "Host")}: {hostUserId ? hostUserId : "-"}</span>
        </div>
      </header>
      <section className="cards">
        <article className="card">
          <h2>{tr("5-kamp", "Pentathlon")}</h2>
          <p>{tr("Allt ackumuleras i CHKN-poäng. Vinn totalt med smart spel.", "Everything accumulates in CHKN points. Win overall with smart play.")}</p>
        </article>
        <article className="card">
          <h2>{tr("Chicken Run", "Chicken Run")}</h2>
          <p>{tr("Snabb vadslagning för maxad nerv.", "Fast betting for maximum tension.")}</p>
        </article>
        <article className="card">
          <h2>{tr("Sputnik", "Sputnik")}</h2>
          <p>{tr("Spela solo mot AI-botten som aldrig blinkar.", "Play solo against the AI bot that never blinks.")}</p>
        </article>
        <article className="card">
          <h2>{tr("Ytzy", "Ytzy")}</h2>
          <p>{tr("Eget spel som nu ligger under Chick'n-appen.", "Custom game now running under the Chick'n app.")}</p>
          <a className="btn-link" href={ytzyBase} target="_blank" rel="noreferrer">
            {tr("Öppna Ytzy", "Open Ytzy")}
          </a>
        </article>
      </section>
      <section className="log">
        <h3>{tr("Realtidslogg", "Realtime log")}</h3>
        <ul>
          {log.map((line, i) => (
            <li key={`${line}-${i}`}>{line}</li>
          ))}
        </ul>
      </section>
      <section className="players">
        <h3>{tr("Spelare", "Players")}</h3>
        {players.length === 0 ? (
          <p>{tr("Inga spelare anslutna.", "No players connected.")}</p>
        ) : (
          <ul>
            {players.map((p, idx) => {
              const isReady = readySet.has(p.userId);
              const seat = ["P1", "P2", "P3", "P4", "P5", "P6"][idx] ?? "-";
              return (
                <li key={p.userId}>
                  <span className={isReady ? "ready-chip" : "ready-chip off"}>
                    {isReady ? tr("Redo", "Ready") : tr("Inte redo", "Not ready")}
                  </span>
                  <span className="player-seat">{seat}</span>
                  <span className="player-id">{p.userId}</span>
                  <span className="player-stack">{tr("Stack", "Stack")}: {p.stack}</span>
                  <span className="you-tag">{selfId === p.userId ? "(Du)" : ""}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {stage === "BLACKJACK" ? (
        <section className="blackjack">
          <h3>{tr("Blackjack", "Blackjack")}</h3>
          <div className="bj-table">
            <div className="bj-row">
              <div className="bj-label">{tr("Dealer", "Dealer")}: Nina</div>
              <div className="bj-cards">
                {bjDealer?.cards?.length ? (
                  bjDealer.cards.map((c, i) => (
                    <span key={`d-${i}`} className="bj-card bj-card--deal" style={{ animationDelay: `${i * 0.08}s` }}>
                      {c.rank}
                      {c.suit}
                    </span>
                  ))
                ) : (
                  <span className="bj-empty">{tr("Inga kort", "No cards")}</span>
                )}
                {bjDealer?.hidden ? <span className="bj-hidden">+{bjDealer.hidden} dolda</span> : null}
              </div>
              <div className="bj-meta">{tr("Total", "Total")}: {bjDealer ? bjDealer.total : "-"}</div>
            </div>
            <div className="bj-row">
              <div className="bj-label">Nina</div>
              <div className="bj-meta bj-quote">{ninaLine || tr("Sätt en bet så börjar vi.", "Place a bet and we start.")}</div>
            </div>
            <div className="bj-row">
              <div className="bj-label">{tr("Dina händer", "Your hands")}</div>
              <div className="bj-hands">
                {bjHands
                  .filter((h) => h.userId === selfId)
                  .sort((a, b) => (a.spot - b.spot) || (a.handIndex - b.handIndex))
                  .map((hand) => (
                    <div className="bj-hand" key={`${hand.userId}:${hand.spot}:${hand.handIndex}`}>
                      <div className="bj-hand-title">
                        {tr("Spot", "Spot")} {hand.spot} • {tr("Insats", "Bet")} {hand.bet}
                      </div>
                      <div className="bj-cards">
                        {hand.cards.map((c, i) => (
                          <span
                            key={`${hand.spot}-${hand.handIndex}-${i}`}
                            className="bj-card bj-card--deal"
                            style={{ animationDelay: `${i * 0.08}s` }}
                          >
                            {c.rank}
                            {c.suit}
                          </span>
                        ))}
                      </div>
                      <div className="bj-meta">
                        {tr("Total", "Total")}: {hand.total} • {tr("Status", "Status")}: {hand.status}
                        {hand.result ? ` • ${tr("Resultat", "Result")}: ${hand.result}` : ""}
                        {hand.sideBet ? ` • ${tr("Sidebet", "Side bet")}: ${hand.sideBet}` : ""}
                        {hand.sideResult ? ` (${hand.sideResult})` : ""}
                      </div>
                      {hand.status === "ACTIVE" ? (
                        <div className="bj-actions">
                          <button className="btn-ghost" onClick={() => sendBjAction(hand.spot, "HIT", hand.handIndex)}>
                            {tr("Ta kort", "Hit")}
                          </button>
                          <button className="btn-ghost" onClick={() => sendBjAction(hand.spot, "STAND", hand.handIndex)}>
                            {tr("Stanna", "Stand")}
                          </button>
                          <button className="btn-ghost" onClick={() => sendBjAction(hand.spot, "DOUBLE", hand.handIndex)}>
                            {tr("Dubbla", "Double")}
                          </button>
                          <button className="btn-ghost" onClick={() => sendBjAction(hand.spot, "SPLIT", hand.handIndex)}>
                            {tr("Splitta", "Split")}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                {bjHands.filter((h) => h.userId === selfId).length === 0 ? (
                  <p className="bj-empty">{tr("Inga händer ännu.", "No hands yet.")}</p>
                ) : null}
              </div>
            </div>
          </div>
          <div className="bj-betting">
            <div className="bj-label">{tr("Betta", "Place bet")} ({tr("runda", "round")} {bjRound || "-"})</div>
            <div className="bj-controls">
              <input
                className="join-input"
                value={bjSpots}
                onChange={(e) => setBjSpots(e.target.value)}
                placeholder={tr("Spots ex: 1,2,3", "Spots e.g.: 1,2,3")}
              />
              <input
                className="join-input"
                type="number"
                min={10}
                max={100}
                value={bjBet}
                onChange={(e) => setBjBet(Number(e.target.value))}
                placeholder={tr("Insats", "Bet")}
              />
              <select className="join-input" value={bjSide} onChange={(e) => setBjSide(e.target.value as "NONE" | "UNDER" | "OVER")}>
                <option value="NONE">{tr("Sidebet: ingen", "Sidebet: none")}</option>
                <option value="UNDER">{tr("Sidebet: under 13", "Sidebet: under 13")}</option>
                <option value="OVER">{tr("Sidebet: över 13", "Sidebet: over 13")}</option>
              </select>
              <button className="btn-primary" onClick={placeBjBet} disabled={!matchId || !bjRound}>
                {tr("Placera bet", "Place bet")}
              </button>
            </div>
            <p className="bj-rules">
              {tr(
                "Regler: Split och Double tillåtet. Sidebet under/över 13 gäller första två korten. Push på 20. Dealer vinner lika på 17-19. Blackjack slår 21 på tre kort.",
                "Rules: Split and Double allowed. Sidebet under/over 13 applies to the first two cards. Push on 20. Dealer wins ties on 17-19. Blackjack beats 21 on three cards."
              )}
            </p>
          </div>
        </section>
      ) : null}
      <section className="debug">
        <h3>{tr("Debug", "Debug")}: sputnet.world</h3>
        {authDebug ? (
          <div>
            <p>
              {tr("Inloggning", "Login")}: <strong>{authDebug.hasAuthentik ? "OK" : tr("Saknas", "Missing")}</strong>
            </p>
            <p>{tr("Headers", "Headers")}: {authDebug.headers.length ? authDebug.headers.join(", ") : tr("inga", "none")}</p>
          </div>
        ) : (
          <p>{tr("Ingen debug-data mottagen.", "No debug data received.")}</p>
        )}
      </section>
      </>
      ) : null}
    </main>
  );
}
