import { describe, it, expect } from 'vitest';
import { signPayload, verifySignature } from '../src/hmac.js';

const secret = 'test-secret';
const body = '{"project":"demo"}';

describe('hmac', () => {
  it('서명 생성 후 검증 통과', () => {
    const ts = 1700000000000;
    const sig = signPayload(body, ts, secret);
    expect(verifySignature({ body, timestampMs: ts, signature: sig, secret, nowMs: ts + 1000 })).toBe(true);
  });

  it('본문 변조 시 실패', () => {
    const ts = 1700000000000;
    const sig = signPayload(body, ts, secret);
    expect(verifySignature({ body: body + 'x', timestampMs: ts, signature: sig, secret, nowMs: ts })).toBe(false);
  });

  it('시크릿 불일치 시 실패', () => {
    const ts = 1700000000000;
    const sig = signPayload(body, ts, secret);
    expect(verifySignature({ body, timestampMs: ts, signature: sig, secret: 'other', nowMs: ts })).toBe(false);
  });

  it('타임스탬프 5분 초과 시 실패 (재전송 방지)', () => {
    const ts = 1700000000000;
    const sig = signPayload(body, ts, secret);
    expect(verifySignature({ body, timestampMs: ts, signature: sig, secret, nowMs: ts + 301_000 })).toBe(false);
  });

  it('서명 길이 불일치에도 예외 없이 false', () => {
    expect(verifySignature({ body, timestampMs: 1, signature: 'ff', secret, nowMs: 1 })).toBe(false);
  });
});
