import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const envSchema = z.object({
  MEDIATOR_TOKEN: z.string().min(32, 'mediator token must be ≥32 chars'),
  DB_PATH: z.string().default('/workspace/data.db'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().url().optional(),
  MAX_LONG_POLL_SECONDS: z.coerce.number().int().positive().max(120).default(30),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PAIR_REQUEST_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  CLOCK_SKEW_SECONDS: z.coerce.number().int().nonnegative().default(300),
  UNACKED_MESSAGE_TTL_SECONDS: z.coerce.number().int().positive().default(120),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('[config] invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  mediatorToken: env.MEDIATOR_TOKEN,
  dbPath: env.DB_PATH,
  port: env.PORT,
  host: env.HOST,
  publicUrl: env.PUBLIC_URL,
  maxLongPollSeconds: env.MAX_LONG_POLL_SECONDS,
  logLevel: env.LOG_LEVEL,
  pairRequestTtlMs: env.PAIR_REQUEST_TTL_SECONDS * 1000,
  clockSkewMs: env.CLOCK_SKEW_SECONDS * 1000,
  unackedMessageTtlMs: env.UNACKED_MESSAGE_TTL_SECONDS * 1000,
};
