import { describe, it, expect, vi } from 'vitest';
import { DeployerClient } from '../src/client.js';
import { signPayload } from '../src/hmac.js';

describe('DeployerClient', () => {
  it('POST: HMAC 헤더 부착', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const now = () => 1700000000000;
    const c = new DeployerClient({ baseUrl: 'https://h.example.com', secret: 's', fetchFn: f as never, now });
    await c.deploy({ project: 'demo', image: 'i', sha: 'x' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://h.example.com/deploy');
    expect(init.headers['x-hoster-timestamp']).toBe('1700000000000');
    expect(init.headers['x-hoster-signature']).toBe(signPayload(init.body, 1700000000000, 's'));
  });

  it('GET: 빈 body로 서명', async () => {
    const f = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    const now = () => 1700000000000;
    const c = new DeployerClient({ baseUrl: 'https://h', secret: 's', fetchFn: f as never, now });
    await c.status();
    const [, init] = f.mock.calls[0];
    expect(init.headers['x-hoster-signature']).toBe(signPayload('', 1700000000000, 's'));
    expect(init.body).toBeUndefined();
  });

  it('비2xx면 에러', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{"error":"invalid signature"}', { status: 401 }));
    const c = new DeployerClient({ baseUrl: 'https://h', secret: 's', fetchFn: f as never });
    await expect(c.status()).rejects.toThrow(/401/);
  });

  it('logs는 텍스트 반환', async () => {
    const f = vi.fn().mockResolvedValue(new Response('log-line\n', { status: 200 }));
    const c = new DeployerClient({ baseUrl: 'https://h', secret: 's', fetchFn: f as never });
    expect(await c.logs('demo', 50)).toBe('log-line\n');
    expect(String(f.mock.calls[0][0])).toBe('https://h/logs/demo?tail=50');
  });

  it('round-trip POST: DeployerClient 서명 → deployer verifySignature (비ASCII 포함)', async () => {
    const { verifySignature } = await import('../../deployer/src/hmac.js');
    const secret = 'test-secret';
    const now = () => 1700000000000;
    const f = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const c = new DeployerClient({ baseUrl: 'https://h', secret, fetchFn: f as never, now });
    await c.deploy({ project: 'demo', image: 'i', sha: 'x', note: '한글 값 テスト 🚀' } as never);

    const [, init] = f.mock.calls[0];
    const capturedBody = init.body;
    const capturedTs = Number(init.headers['x-hoster-timestamp']);
    const capturedSig = init.headers['x-hoster-signature'];

    expect(capturedBody).toContain('한글 값 テスト 🚀');

    const isValid = verifySignature({
      body: capturedBody,
      timestampMs: capturedTs,
      signature: capturedSig,
      secret,
      nowMs: capturedTs,
    });

    expect(isValid).toBe(true);
  });

  it('round-trip GET: DeployerClient 서명 → deployer verifySignature (빈 body)', async () => {
    const { verifySignature } = await import('../../deployer/src/hmac.js');
    const secret = 'test-secret';
    const now = () => 1700000000000;
    const f = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));

    const c = new DeployerClient({ baseUrl: 'https://h', secret, fetchFn: f as never, now });
    await c.status();

    const [, init] = f.mock.calls[0];
    const capturedBody = init.body;
    const capturedTs = Number(init.headers['x-hoster-timestamp']);
    const capturedSig = init.headers['x-hoster-signature'];

    expect(capturedBody).toBeUndefined();

    const isValid = verifySignature({
      body: '',
      timestampMs: capturedTs,
      signature: capturedSig,
      secret,
      nowMs: capturedTs,
    });

    expect(isValid).toBe(true);
  });
});
