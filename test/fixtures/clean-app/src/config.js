export function config() {
  return {
    db: process.env.DATABASE_URL,
    timeout: Number(process.env.API_TIMEOUT_MS ?? 30000),
  };
}
