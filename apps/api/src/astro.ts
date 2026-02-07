import { createRequire } from "node:module";
import path from "node:path";

type ProfileRow = {
  birth_date: string;
  birth_time: string | null;
  unknown_time: boolean;
  birth_place: string;
  birth_lat: number | null;
  birth_lng: number | null;
  tz_name: string | null;
  tz_offset_minutes: number | null;
};

type PlanetPosition = {
  name: string;
  lon: number;
  lat: number;
  dist: number;
  speedLon: number;
  speedLat: number;
  speedDist: number;
  sign: string;
  house: number | null;
};

type HouseInfo = {
  system: string;
  cusps: number[];
  asc: number | null;
  mc: number | null;
};

type Aspect = {
  a: string;
  b: string;
  angle: number;
  orb: number;
  exact: number;
  type: string;
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

const ASPECTS = [
  { name: "conjunction", angle: 0 },
  { name: "sextile", angle: 60 },
  { name: "square", angle: 90 },
  { name: "trine", angle: 120 },
  { name: "opposition", angle: 180 },
];

const isLuminary = (name: string) => name === "Sun" || name === "Moon";

const normalizeAngle = (angle: number) => {
  const v = angle % 360;
  return v < 0 ? v + 360 : v;
};

const diffAngle = (a: number, b: number) => {
  const d = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return d > 180 ? 360 - d : d;
};

const signFromLon = (lon: number) => SIGNS[Math.floor(normalizeAngle(lon) / 30) % 12];

const toDateString = (birthDate: string | Date) => {
  if (birthDate instanceof Date) {
    const y = birthDate.getFullYear();
    const m = String(birthDate.getMonth() + 1).padStart(2, "0");
    const d = String(birthDate.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(birthDate);
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

const toUtcDate = (
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
  second: number,
  offsetMinutes: number
) => {
  const utcMs = Date.UTC(y, m - 1, d, hour, minute, second) - offsetMinutes * 60 * 1000;
  return new Date(utcMs);
};

const getHouseForLon = (lon: number, cusps: number[]) => {
  if (cusps.length !== 12) return null;
  const lonNorm = normalizeAngle(lon);
  for (let i = 0; i < 12; i += 1) {
    const start = normalizeAngle(cusps[i]);
    const endRaw = cusps[(i + 1) % 12];
    const end = normalizeAngle(endRaw);
    const span = end <= start ? end + 360 : end;
    const lonAdj = lonNorm < start ? lonNorm + 360 : lonNorm;
    if (lonAdj >= start && lonAdj < span) return i + 1;
  }
  return null;
};

const normalizeCalcResult = (res: any) => {
  if (!res) throw new Error("swe_calc_failed");
  if (Array.isArray(res)) {
    if (res.length >= 6 && res.every((v) => typeof v === "number")) {
      return {
        lon: res[0],
        lat: res[1],
        dist: res[2],
        speedLon: res[3],
        speedLat: res[4],
        speedDist: res[5],
      };
    }
    if (res.length === 2 && Array.isArray(res[1])) {
      return normalizeCalcResult(res[1]);
    }
    if (res.length === 1 && Array.isArray(res[0])) {
      return normalizeCalcResult(res[0]);
    }
  }
  if (typeof res.longitude === "number") {
    return {
      lon: res.longitude,
      lat: res.latitude ?? 0,
      dist: res.distance ?? 0,
      speedLon: res.longitudeSpeed ?? 0,
      speedLat: res.latitudeSpeed ?? 0,
      speedDist: res.distanceSpeed ?? 0,
    };
  }
  if (typeof res.lon === "number") {
    return {
      lon: res.lon,
      lat: res.lat ?? 0,
      dist: res.dist ?? 0,
      speedLon: res.speedLon ?? 0,
      speedLat: res.speedLat ?? 0,
      speedDist: res.speedDist ?? 0,
    };
  }
  if (res.position && typeof res.position.longitude === "number") {
    return {
      lon: res.position.longitude,
      lat: res.position.latitude ?? 0,
      dist: res.position.distance ?? 0,
      speedLon: res.position.longitudeSpeed ?? 0,
      speedLat: res.position.latitudeSpeed ?? 0,
      speedDist: res.position.distanceSpeed ?? 0,
    };
  }
  throw new Error("swe_calc_invalid");
};

const normalizeHouses = (res: any) => {
  if (!res) throw new Error("swe_houses_failed");
  if (Array.isArray(res) && res.length >= 2) {
    const cusps = res[0];
    const ascmc = res[1];
    return {
      cusps: Array.isArray(cusps) ? cusps.slice(1, 13) : [],
      asc: Array.isArray(ascmc) ? ascmc[0] : null,
      mc: Array.isArray(ascmc) ? ascmc[1] : null,
    };
  }
  if (Array.isArray(res.cusps)) {
    return {
      cusps: res.cusps.length === 13 ? res.cusps.slice(1) : res.cusps.slice(0, 12),
      asc: res.asc ?? res.ascendant ?? null,
      mc: res.mc ?? res.mediumCoeli ?? null,
    };
  }
  if (Array.isArray(res.house)) {
    return {
      cusps: res.house.slice(0, 12),
      asc: res.ascendant ?? res.asc ?? null,
      mc: res.mc ?? res.mediumCoeli ?? null,
    };
  }
  return {
    cusps: [],
    asc: res.asc ?? null,
    mc: res.mc ?? null,
  };
};

const calcAspectOrb = (a: string, b: string) => Math.max(isLuminary(a) ? 8 : 6, isLuminary(b) ? 8 : 6);

export async function computeBirthChart(profile: ProfileRow) {
  const require = createRequire(import.meta.url);
  const swe = require("swisseph");
  const envPath = (process.env.SWEPH_PATH || "").trim();
  let ephePath = envPath;
  if (!ephePath) {
    try {
      const pkgPath = require.resolve("swisseph/package.json");
      ephePath = path.join(path.dirname(pkgPath), "ephe");
    } catch {
      ephePath = "";
    }
  }
  if (ephePath && typeof swe.swe_set_ephe_path === "function") {
    swe.swe_set_ephe_path(ephePath);
  }

  if (profile.birth_lat === null || profile.birth_lng === null) {
    throw new Error("missing_coordinates");
  }
  const lat = Number(profile.birth_lat);
  const lng = Number(profile.birth_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("invalid_coordinates");
  }

  const { y, m, d } = parseBirthDate(profile.birth_date);
  const time = parseBirthTime(profile.birth_time, profile.unknown_time);
  const offsetMinutes = Number.isFinite(profile.tz_offset_minutes as number)
    ? Number(profile.tz_offset_minutes)
    : 0;
  const utcDate = toUtcDate(y, m, d, time.hour, time.minute, time.second, offsetMinutes);
  const utHours =
    utcDate.getUTCHours() +
    utcDate.getUTCMinutes() / 60 +
    utcDate.getUTCSeconds() / 3600 +
    utcDate.getUTCMilliseconds() / 3600000;

  const jd = swe.swe_julday(
    utcDate.getUTCFullYear(),
    utcDate.getUTCMonth() + 1,
    utcDate.getUTCDate(),
    utHours,
    swe.SE_GREG_CAL
  );

  const flagsPrimary = swe.SEFLG_SWIEPH | swe.SEFLG_SPEED;
  const flagsFallback =
    typeof swe.SEFLG_MOSEPH === "number" ? swe.SEFLG_MOSEPH | swe.SEFLG_SPEED : flagsPrimary;

  const sweCalcUt = async (planet: number) => {
    if (typeof swe.swe_calc_ut !== "function") throw new Error("swisseph_missing");
    if (swe.swe_calc_ut.length >= 4) {
      return new Promise((resolve, reject) => {
        swe.swe_calc_ut(jd, planet, flagsPrimary, (ret: number, result: any) => {
          if (ret < 0) {
            swe.swe_calc_ut(jd, planet, flagsFallback, (ret2: number, result2: any) => {
              if (ret2 < 0) reject(new Error("swe_calc_failed"));
              else resolve(result2);
            });
          } else {
            resolve(result);
          }
        });
      });
    }
    const res = swe.swe_calc_ut(jd, planet, flagsPrimary);
    if (!res || res.error) {
      const fallback = swe.swe_calc_ut(jd, planet, flagsFallback);
      if (!fallback || fallback.error) return null;
      return fallback;
    }
    return res;
  };

  const sweHouses = async () => {
    if (typeof swe.swe_houses !== "function") throw new Error("swisseph_missing");
    if (swe.swe_houses.length >= 5) {
      return new Promise((resolve, reject) => {
        swe.swe_houses(jd, lat, lng, "W", (res: any) => {
          if (!res) reject(new Error("swe_houses_failed"));
          else resolve(res);
        });
      });
    }
    return swe.swe_houses(jd, lat, lng, "W");
  };

  const bodies = [
    { key: "Sun", id: swe.SE_SUN },
    { key: "Moon", id: swe.SE_MOON },
    { key: "Mercury", id: swe.SE_MERCURY },
    { key: "Venus", id: swe.SE_VENUS },
    { key: "Mars", id: swe.SE_MARS },
    { key: "Jupiter", id: swe.SE_JUPITER },
    { key: "Saturn", id: swe.SE_SATURN },
    { key: "Uranus", id: swe.SE_URANUS },
    { key: "Neptune", id: swe.SE_NEPTUNE },
    { key: "Pluto", id: swe.SE_PLUTO },
    { key: "North Node", id: swe.SE_MEAN_NODE },
    { key: "Lilith", id: swe.SE_MEAN_APOG },
    { key: "Chiron", id: swe.SE_CHIRON },
  ];

  const rawHouses = await sweHouses();
  const houseInfo = normalizeHouses(rawHouses);

  const planets: PlanetPosition[] = [];
  for (const body of bodies) {
    const raw = await sweCalcUt(body.id);
    if (!raw) continue;
    const pos = normalizeCalcResult(raw);
    planets.push({
      name: body.key,
      lon: normalizeAngle(pos.lon),
      lat: pos.lat,
      dist: pos.dist,
      speedLon: pos.speedLon,
      speedLat: pos.speedLat,
      speedDist: pos.speedDist,
      sign: signFromLon(pos.lon),
      house: getHouseForLon(pos.lon, houseInfo.cusps),
    });
  }

  const points = [
    { name: "ASC", lon: houseInfo.asc },
    { name: "MC", lon: houseInfo.mc },
  ].filter((p) => typeof p.lon === "number") as Array<{ name: string; lon: number }>;

  const aspects: Aspect[] = [];
  const bodiesForAspects = [...planets.map((p) => ({ name: p.name, lon: p.lon })), ...points];

  for (let i = 0; i < bodiesForAspects.length; i += 1) {
    for (let j = i + 1; j < bodiesForAspects.length; j += 1) {
      const a = bodiesForAspects[i];
      const b = bodiesForAspects[j];
      const delta = diffAngle(a.lon, b.lon);
      const orbLimit = calcAspectOrb(a.name, b.name);
      for (const aspect of ASPECTS) {
        const orb = Math.abs(delta - aspect.angle);
        if (orb <= orbLimit) {
          aspects.push({
            a: a.name,
            b: b.name,
            angle: aspect.angle,
            orb,
            exact: delta,
            type: aspect.name,
          });
          break;
        }
      }
    }
  }

  const houseData: HouseInfo = {
    system: "W",
    cusps: houseInfo.cusps.map((v: number) => normalizeAngle(Number(v))),
    asc: houseInfo.asc !== null && houseInfo.asc !== undefined ? normalizeAngle(Number(houseInfo.asc)) : null,
    mc: houseInfo.mc !== null && houseInfo.mc !== undefined ? normalizeAngle(Number(houseInfo.mc)) : null,
  };

  return {
    meta: {
      calculated_at: new Date().toISOString(),
      engine: "swisseph",
      house_system: "W",
      unknown_time: profile.unknown_time,
      assumed_time: time.assumed ? "12:00" : null,
      tz_name: profile.tz_name ?? null,
      tz_offset_minutes: offsetMinutes,
    },
    input: {
      birth_date: toDateString(profile.birth_date),
      birth_time: profile.birth_time,
      birth_place: profile.birth_place,
      birth_lat: lat,
      birth_lng: lng,
      utc_iso: utcDate.toISOString(),
      jd_ut: jd,
    },
    houses: houseData,
    planets,
    aspects,
  };
}

export type { ProfileRow };
