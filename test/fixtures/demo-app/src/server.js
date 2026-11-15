import { createServer } from 'node:http';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_SIZE ?? 10),
});

const redisUrl = process.env['REDIS_URL'];
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) throw new Error('JWT_SECRET is required');

const ttl = parseInt(process.env.SESSION_TTL ?? '3600', 10);
const featureX = process.env.ENABLE_FEATURE_X === 'true';

// dynamic lookup — envdrift should flag but not classify
const key = 'STRIPE_API_KEY';
const stripeKey = process.env[key];

// intentionally missing from .env.example:
const queueUrl = process.env.QUEUE_REDIS_URL;
const smtpPassword = process.env.SMTP_PASSWORD;

createServer(async (req, res) => {
  const cfg = await import('./config/settings.js');
  res.end(JSON.stringify({ ok: !!cfg.default.sentryDsn, featureX, ttl }));
}).listen(Number(process.env.PORT ?? 3000));

export { pool, redisUrl, stripeKey, queueUrl, smtpPassword };
