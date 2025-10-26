describe('Analyzer envs', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('parses environment variables', async () => {
    process.env['PORT'] = '3002';
    process.env['NATS_SERVERS'] = 'nats://localhost:4222';
    process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/db';
    process.env['OPENAI_API_KEY'] = 'key';
    process.env['OPENAI_MODEL'] = 'gpt-4o-mini';
    process.env['OPENAI_REQUEST_TIMEOUT_MS'] = '15000';
    process.env['OPENAI_MAX_RETRIES'] = '1';
    process.env['PROCESSING_CONCURRENCY'] = '3';

    const { envs } = await import('./envs');

    expect(envs.openAiApiKey).toBe('key');
    expect(envs.openAiTimeoutMs).toBe(15000);
    expect(envs.processingConcurrency).toBe(3);
  });
});
