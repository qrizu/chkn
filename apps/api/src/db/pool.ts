import pg from "pg";

const { Pool } = pg;

const url = (process.env.DATABASE_URL || "").trim();
const schema = (process.env.CHKN_DB_SCHEMA || "chkn").trim() || "chkn";

function wantSsl(): boolean {
  const v = (process.env.APP_DB_SSL || process.env.PGSSLMODE || process.env.DATABASE_SSL || "")
    .toString()
    .toLowerCase();
  return v === "1" || v === "true" || v === "require" || v === "required";
}

let pool: pg.Pool;

if (url) {
  const sslEnabled = wantSsl();
  pool = new Pool({
    connectionString: url,
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_MS || 30_000),
    connectionTimeoutMillis: Number(process.env.PGPOOL_CONN_TIMEOUT_MS || 10_000),
    options: `-c search_path=${schema},public`,
    ...(sslEnabled ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  pool.on("error", (err) => {
    console.error("[db] pool error:", err?.message || err);
  });
} else {
  console.warn("[db] DATABASE_URL missing – DB features disabled.");
  pool = new Pool({});
  // Override methods to throw clearly if used.
  const err = new Error("DATABASE_URL missing. Set DATABASE_URL for Postgres.");
  // @ts-expect-error override for stub
  pool.query = async () => {
    throw err;
  };
  // @ts-expect-error override for stub
  pool.connect = async () => {
    throw err;
  };
}

export { pool };
export default pool;
