import { createClient, type RedisClientType } from "redis";

const url = (process.env.REDIS_URL || "").trim();

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType> | null = null;

export const getRedis = async (): Promise<RedisClientType> => {
  if (!url) {
    throw new Error("REDIS_URL missing. Set REDIS_URL to enable Redis.");
  }
  if (client) return client;
  if (connecting) return connecting;

  const next = createClient({ url });
  next.on("error", (err) => {
    console.error("[redis] error:", err?.message || err);
  });

  connecting = next.connect().then(() => {
    client = next;
    return next;
  });

  return connecting;
};

export const closeRedis = async (): Promise<void> => {
  if (!client) return;
  await client.quit();
  client = null;
  connecting = null;
};
