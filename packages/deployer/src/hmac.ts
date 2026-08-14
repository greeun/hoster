import { createHmac, timingSafeEqual } from 'node:crypto';

export function signPayload(body: string, timestampMs: number, secret: string): string {
  return createHmac('sha256', secret).update(`${timestampMs}.${body}`).digest('hex');
}

export function verifySignature(opts: {
  body: string;
  timestampMs: number;
  signature: string;
  secret: string;
  nowMs?: number;
  maxSkewMs?: number;
}): boolean {
  const { body, timestampMs, signature, secret } = opts;
  const nowMs = opts.nowMs ?? Date.now();
  const maxSkewMs = opts.maxSkewMs ?? 300_000;
  if (!Number.isFinite(timestampMs)) return false;
  if (Math.abs(nowMs - timestampMs) > maxSkewMs) return false;
  const expected = Buffer.from(signPayload(body, timestampMs, secret), 'hex');
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
