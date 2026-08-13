import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies documented defaults when no relevant env vars are set', () => {
    const config = loadConfig({});

    expect(config.LLM_PROVIDER).toBe('rules');
    expect(config.EMBEDDING_PROVIDER).toBe('local');
    expect(config.LOG_LEVEL).toBe('info');
    // Phase 5: DATABASE_URL defaults to the docker-compose.yml Postgres
    // service's own credentials/port — required for the spec §18
    // zero-config clean-machine bootstrap (no env vars set at all).
    expect(config.DATABASE_URL).toBe(
      'postgres://postgres:postgres@localhost:5432/deal_signal_engine',
    );
    expect(config.GITHUB_TOKEN).toBeUndefined();
  });

  it('honors explicit valid overrides for every field', () => {
    const config = loadConfig({
      LLM_PROVIDER: 'ollama',
      EMBEDDING_PROVIDER: 'deterministic',
      LOG_LEVEL: 'debug',
      DATABASE_URL: 'postgres://localhost:5432/deal_signal',
      GITHUB_TOKEN: 'ghp_example',
    });

    expect(config.LLM_PROVIDER).toBe('ollama');
    expect(config.EMBEDDING_PROVIDER).toBe('deterministic');
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.DATABASE_URL).toBe('postgres://localhost:5432/deal_signal');
    expect(config.GITHUB_TOKEN).toBe('ghp_example');
  });

  it('throws ConfigValidationError for an unrecognized LLM_PROVIDER value', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'gpt4' })).toThrow(ConfigValidationError);
  });

  it('throws ConfigValidationError for an unrecognized LOG_LEVEL value', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'super-verbose' })).toThrow(ConfigValidationError);
  });

  it('produces a readable, actionable message naming the offending field, not a raw Zod stack trace', () => {
    try {
      loadConfig({ EMBEDDING_PROVIDER: 'openai' });
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const message = (err as ConfigValidationError).message;
      expect(message).toContain('EMBEDDING_PROVIDER');
      expect(message).toContain('Invalid environment configuration');
      expect(message).not.toContain('ZodError');
    }
  });

  it('ignores unrelated ambient env vars (e.g. PATH) instead of rejecting them', () => {
    const config = loadConfig({ PATH: '/usr/bin', HOME: '/home/user' } as NodeJS.ProcessEnv);

    expect(config.LLM_PROVIDER).toBe('rules');
  });
});
