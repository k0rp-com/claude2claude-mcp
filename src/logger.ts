type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEYS = /token|secret|password|api[_-]?key|authorization|cookie/i;

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

export function makeLogger(level: Level) {
  const threshold = order[level];
  function log(lvl: Level, event: string, fields?: Record<string, unknown>) {
    if (order[lvl] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      event,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    });
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }
  return {
    debug: (e: string, f?: Record<string, unknown>) => log('debug', e, f),
    info: (e: string, f?: Record<string, unknown>) => log('info', e, f),
    warn: (e: string, f?: Record<string, unknown>) => log('warn', e, f),
    error: (e: string, f?: Record<string, unknown>) => log('error', e, f),
  };
}
