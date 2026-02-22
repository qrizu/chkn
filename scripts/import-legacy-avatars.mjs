import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

const repoRoot = path.resolve(process.cwd(), "../..");
const envPath = path.join(repoRoot, ".env");

const avatarDirs = [
  path.join(repoRoot, "services/chkn/apps/web/public/avatars"),
  path.join(repoRoot, "services/yatzy/frontend/public/avatars"),
];

const extToMime = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const hostCandidates = [
  (process.env.PGHOST_IMPORT || "").trim(),
  "10.10.0.110",
  "127.0.0.1",
].filter(Boolean);

function parseEnv(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function makeUserIdCandidates(stem) {
  const raw = String(stem || "").trim().replace(/\.[a-z0-9]+$/i, "");
  if (!raw) return [];
  const lower = raw.toLowerCase();
  return Array.from(new Set([raw, lower])).filter((v) => v.length <= 256);
}

async function collectAvatars() {
  const byUserId = new Map();
  for (const dir of avatarDirs) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const mimeType = extToMime[ext];
      if (!mimeType) continue;
      const stem = path.basename(entry.name, ext);
      if (stem.toLowerCase() === "default") continue;
      const userIds = makeUserIdCandidates(stem);
      if (!userIds.length) continue;
      const filePath = path.join(dir, entry.name);
      const data = await fs.readFile(filePath);
      for (const userId of userIds) {
        if (byUserId.has(userId)) continue;
        byUserId.set(userId, {
          userId,
          mimeType,
          data,
          source: filePath,
        });
      }
    }
  }
  return Array.from(byUserId.values());
}

async function openPoolWithFallback(connection, targetName) {
  let lastErr = null;
  for (const host of hostCandidates) {
    const pool = new Pool({
      host,
      port: 5432,
      user: connection.user,
      password: connection.password,
      database: connection.database,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
    });
    try {
      await pool.query("SELECT 1");
      console.log(`[${targetName}] connected via ${host}`);
      return pool;
    } catch (err) {
      lastErr = err;
      await pool.end().catch(() => undefined);
    }
  }
  throw lastErr || new Error(`[${targetName}] could not connect to postgres`);
}

async function ensureAvatarTable(pool) {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chkn.user_avatars (
        user_id TEXT PRIMARY KEY,
        avatar_mime_type TEXT NOT NULL,
        avatar_data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (err) {
    const msg = String(err?.message || err);
    if (!msg.toLowerCase().includes("permission denied")) throw err;
    const exists = await pool.query(`SELECT to_regclass('chkn.user_avatars') AS t`);
    if (!exists.rows[0]?.t) throw err;
  }
}

async function importToTarget(targetName, connection, avatars) {
  const pool = await openPoolWithFallback(connection, targetName);
  try {
    await ensureAvatarTable(pool);
    let imported = 0;
    for (const avatar of avatars) {
      await pool.query(
        `INSERT INTO chkn.user_avatars (user_id, avatar_mime_type, avatar_data)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id)
         DO UPDATE SET
           avatar_mime_type = EXCLUDED.avatar_mime_type,
           avatar_data = EXCLUDED.avatar_data,
           updated_at = NOW()`,
        [avatar.userId, avatar.mimeType, avatar.data]
      );
      imported += 1;
    }
    const countRes = await pool.query(`SELECT COUNT(*)::int AS count FROM chkn.user_avatars`);
    console.log(`[${targetName}] upserts: ${imported}, total rows now: ${countRes.rows[0].count}`);
  } finally {
    await pool.end();
  }
}

async function main() {
  const rawEnv = await fs.readFile(envPath, "utf8");
  const env = parseEnv(rawEnv);

  const targets = [
    {
      name: "prod",
      user: env.CHKN_USER_PROD,
      password: env.CHKN_PASS_PROD,
      database: env.CHKN_DB_PROD,
    },
    {
      name: "dev",
      user: env.CHKN_USER_DEV,
      password: env.CHKN_PASS_DEV,
      database: env.CHKN_DB_DEV,
    },
  ];

  for (const target of targets) {
    if (!target.user || !target.password || !target.database) {
      throw new Error(`Missing CHKN DB vars for target "${target.name}" in ${envPath}`);
    }
  }

  const avatars = await collectAvatars();
  if (!avatars.length) {
    console.log("No legacy avatar files found to import.");
    return;
  }

  console.log(`Prepared ${avatars.length} avatar entries from public avatar folders.`);
  await importToTarget("prod", targets[0], avatars);
  await importToTarget("dev", targets[1], avatars);
}

main().catch((err) => {
  console.error("import-legacy-avatars failed:", err?.stack || err);
  process.exit(1);
});
