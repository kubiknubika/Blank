/**
 * Minimal structured (JSON-lines) logger. No dependency: at this scale a
 * 60-line logger beats pulling in pino, and the output format is compatible
 * with any log aggregator. Swap for pino behind the same interface if needed.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(
  level: LogLevel = 'info',
  bindings: Record<string, unknown> = {},
  sink: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Logger {
  const emit = (
    msgLevel: Exclude<LogLevel, 'silent'>,
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    if (LEVEL_WEIGHT[msgLevel] < LEVEL_WEIGHT[level]) return;
    const entry = {
      time: new Date().toISOString(),
      level: msgLevel,
      message,
      ...bindings,
      ...fields,
    };
    sink(JSON.stringify(entry));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger(level, { ...bindings, ...extra }, sink),
  };
}

/** Discards everything — used in tests to keep output clean. */
export const silentLogger: Logger = createLogger('silent');
