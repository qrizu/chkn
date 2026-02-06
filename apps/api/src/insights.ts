import { createRequire } from "node:module";
import { computeBirthChart, type ProfileRow } from "./astro";

type HumanDesignSummary = {
  type: string | null;
  profile: string | null;
  authority: string | null;
  strategy: string | null;
  role: string | null;
};

type InsightsResult = {
  summary: {
    chinese_zodiac: string;
    astrology: {
      sun: string | null;
      moon: string | null;
      ascendant: string | null;
    };
    human_design: HumanDesignSummary;
    meta: {
      assumed_time: string | null;
      timezone: string | null;
      tz_offset_minutes: number;
    };
  };
  astrology: any;
  human_design: any;
};

const SIGNS = [
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

const CHINESE_ZODIAC = [
  "Rat",
  "Ox",
  "Tiger",
  "Rabbit",
  "Dragon",
  "Snake",
  "Horse",
  "Goat",
  "Monkey",
  "Rooster",
  "Dog",
  "Pig",
];

const signFromLon = (lon: number | null) => {
  if (lon === null || Number.isNaN(lon)) return null;
  const idx = Math.floor((((lon % 360) + 360) % 360) / 30);
  return SIGNS[idx] ?? null;
};

const toDateString = (birthDate: string | Date) => {
  if (birthDate instanceof Date) {
    const y = birthDate.getUTCFullYear();
    const m = String(birthDate.getUTCMonth() + 1).padStart(2, "0");
    const d = String(birthDate.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(birthDate);
};

const toDateStringWithTz = (birthDate: string | Date, tzName: string | null) => {
  if (birthDate instanceof Date && tzName && tzSupport?.findTimeZone && tzSupport?.getZonedTime) {
    try {
      const zone = tzSupport.findTimeZone(tzName);
      const zoned = tzSupport.getZonedTime(birthDate, zone);
      if (zoned?.year && zoned?.month && zoned?.day) {
        return `${zoned.year}-${String(zoned.month).padStart(2, "0")}-${String(zoned.day).padStart(2, "0")}`;
      }
    } catch {
      // ignore
    }
  }
  return toDateString(birthDate);
};

const parseBirthDate = (birthDate: string | Date) => {
  const [y, m, d] = toDateString(birthDate).split("-").map((v) => Number(v));
  if (!y || !m || !d) throw new Error("invalid_birth_date");
  return { y, m, d };
};

const parseBirthTime = (birthTime: string | null, unknownTime: boolean) => {
  if (unknownTime || !birthTime) {
    return { hour: 12, minute: 0, second: 0, assumed: true };
  }
  const parts = birthTime.split(":").map((v) => Number(v));
  if (parts.length < 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) {
    throw new Error("invalid_birth_time");
  }
  return { hour: parts[0], minute: parts[1], second: parts[2] || 0, assumed: false };
};

const chineseZodiac = (year: number) => {
  const baseYear = 2020; // Rat
  const idx = ((year - baseYear) % 12 + 12) % 12;
  return CHINESE_ZODIAC[idx] ?? "Unknown";
};

const tzSupport = (() => {
  try {
    const req = createRequire(import.meta.url);
    return req("timezone-support");
  } catch {
    return null;
  }
})();

const calcTzOffsetMinutes = (
  tzName: string | null,
  birthDate: string,
  birthTime: string | null,
  unknownTime: boolean
): number | null => {
  if (!tzName || !birthDate) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null;
  const timeStr = unknownTime ? "12:00:00" : birthTime || "12:00:00";
  const [y, m, d] = birthDate.split("-").map((v) => Number(v));
  const [hh, mm, ss] = timeStr.split(":").map((v) => Number(v));
  if (!y || !m || !d) return null;
  if (tzSupport?.findTimeZone && tzSupport?.getUnixTime) {
    try {
      const zone = tzSupport.findTimeZone(tzName);
      const local = { year: y, month: m, day: d, hours: hh || 0, minutes: mm || 0, seconds: ss || 0 };
      const utcMs = tzSupport.getUnixTime(local, zone);
      const assumedUtcMs = Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0);
      return Math.round((assumedUtcMs - utcMs) / 60000);
    } catch {
      // fallthrough
    }
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tzName,
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
  } catch {
    return null;
  }
};

export async function computeProfileInsights(profile: ProfileRow): Promise<InsightsResult> {
  if (!profile.birth_date || !profile.birth_place) throw new Error("missing_profile");
  if (profile.birth_lat === null || profile.birth_lng === null) {
    throw new Error("missing_coordinates");
  }

  const birthDateString = toDateStringWithTz(profile.birth_date, profile.tz_name ?? null);
  const { y, m, d } = parseBirthDate(birthDateString);
  const time = parseBirthTime(profile.birth_time, profile.unknown_time);
  const tzOffsetComputed = calcTzOffsetMinutes(
    profile.tz_name ?? null,
    birthDateString,
    profile.birth_time,
    profile.unknown_time
  );
  const tzOffsetMinutes =
    typeof tzOffsetComputed === "number"
      ? tzOffsetComputed
      : Number.isFinite(profile.tz_offset_minutes as number)
        ? Number(profile.tz_offset_minutes)
        : 0;
  const birthHourRaw = time.hour + time.minute / 60 + time.second / 3600;
  const birthHour = Number.isFinite(birthHourRaw) ? birthHourRaw : 12;
  const tzOffsetHoursRaw = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes / 60 : 0;
  const tzOffsetHours = Number.isFinite(tzOffsetHoursRaw) ? tzOffsetHoursRaw : 0;

  const require = createRequire(import.meta.url);
  const natal = require("natalengine");
  const calculateHumanDesign = natal?.calculateHumanDesign;
  if (typeof calculateHumanDesign !== "function") {
    throw new Error("human_design_unavailable");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDateString)) {
    throw new Error(`invalid_birth_date_string:${birthDateString}`);
  }
  let humanDesign: any;
  try {
    humanDesign = await calculateHumanDesign(birthDateString, birthHour, tzOffsetHours);
  } catch (err) {
    const msg = [
      "human_design_error",
      `birthDate=${birthDateString}`,
      `birthHour=${birthHour}`,
      `tzOffsetHours=${tzOffsetHours}`,
      `types=${typeof birthDateString}/${typeof birthHour}/${typeof tzOffsetHours}`,
    ].join(";");
    throw new Error(`${msg};${String(err)}`);
  }

  let astrology: any;
  try {
    astrology = await computeBirthChart({ ...profile, tz_offset_minutes: tzOffsetMinutes });
  } catch (err) {
    const msg = [
      "astrology_error",
      `birthDate=${birthDateString}`,
      `birthTime=${profile.birth_time ?? "null"}`,
      `unknownTime=${profile.unknown_time}`,
      `lat=${profile.birth_lat}`,
      `lng=${profile.birth_lng}`,
      `tzOffsetMinutes=${tzOffsetMinutes}`,
    ].join(";");
    throw new Error(`${msg};${String(err)}`);
  }
  const sun = astrology?.planets?.find((p: any) => p.name === "Sun")?.sign ?? null;
  const moon = astrology?.planets?.find((p: any) => p.name === "Moon")?.sign ?? null;
  const asc = signFromLon(astrology?.houses?.asc ?? null);

  const hdType = humanDesign?.type?.name ?? null;
  const hdProfile = humanDesign?.profile?.numbers
    ? String(humanDesign.profile.numbers)
    : humanDesign?.profile?.name ?? null;
  const hdAuthority =
    humanDesign?.authority?.name ?? humanDesign?.type?.authority ?? humanDesign?.authority ?? null;
  const hdStrategy =
    humanDesign?.type?.strategy ?? humanDesign?.strategy?.name ?? humanDesign?.strategy ?? null;
  const hdRole = hdType && hdProfile ? `${hdType} • ${hdProfile}` : hdType ?? null;

  return {
    summary: {
      chinese_zodiac: chineseZodiac(y),
      astrology: {
        sun,
        moon,
        ascendant: asc,
      },
      human_design: {
        type: hdType,
        profile: hdProfile,
        authority: hdAuthority,
        strategy: hdStrategy,
        role: hdRole,
      },
      meta: {
        assumed_time: time.assumed ? "12:00" : null,
        timezone: profile.tz_name ?? null,
        tz_offset_minutes: tzOffsetMinutes,
      },
    },
    astrology,
    human_design: humanDesign,
  };
}

export type { InsightsResult };
