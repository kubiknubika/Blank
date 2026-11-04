import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

describe('loadConfig', () => {
  it('provides sane defaults', () => {
    const config = loadConfig({});
    expect(config.PORT).toBe(3000);
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.SEED_ON_EMPTY).toBe(true);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('coerces and validates env values', () => {
    const config = loadConfig({ PORT: '8080', SEED_ON_EMPTY: 'false', LOG_LEVEL: 'debug' });
    expect(config.PORT).toBe(8080);
    expect(config.SEED_ON_EMPTY).toBe(false);
    expect(config.LOG_LEVEL).toBe('debug');
  });

  it('fails fast on invalid values instead of starting broken', () => {
    expect(() => loadConfig({ PORT: 'not-a-number' })).toThrow(/Invalid environment/);
    expect(() => loadConfig({ PORT: '99999' })).toThrow(/Invalid environment/);
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/Invalid environment/);
  });
});

describe('logger', () => {
  it('emits structured JSON with bindings', () => {
    const lines: string[] = [];
    const log = createLogger('debug', {}, (l) => lines.push(l)).child({ requestId: 'r-1' });
    log.info('hello', { extra: 42 });
    const entry = JSON.parse(lines[0]);
    expect(entry.message).toBe('hello');
    expect(entry.requestId).toBe('r-1');
    expect(entry.extra).toBe(42);
    expect(entry.level).toBe('info');
    expect(entry.time).toBeTruthy();
  });

  it('respects the level threshold', () => {
    const lines: string[] = [];
    const log = createLogger('warn', {}, (l) => lines.push(l));
    log.debug('nope');
    log.info('nope');
    log.warn('yes');
    log.error('yes');
    expect(lines).toHaveLength(2);
  });
});
