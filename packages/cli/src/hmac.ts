import { createHmac } from 'node:crypto';

export function signPayload(body: string, timestampMs: number, secret: string): string {
  return createHmac('sha256', secret).update(`${timestampMs}.${body}`).digest('hex');
}
