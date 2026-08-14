import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig } from '../src/config.js';

const sample = {
  nas: { host: '192.168.1.100', port: 2222, user: 'admin' },
  cloudflare: { apiToken: 't', zoneId: 'z', accountId: 'a', tunnelId: 'tn' },
  baseDomain: 'example.com',
  deployerUrl: 'https://hoster.example.com',
  hmacSecret: 'x', ghcrPat: 'p',
};

describe('config', () => {
  it('save 후 load 왕복', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hoster-')), 'config.json');
    saveConfig(sample, path);
    expect(loadConfig(path)).toEqual(sample);
  });

  it('파일 없으면 안내 에러', () => {
    expect(() => loadConfig('/nonexistent/config.json')).toThrow(/hoster init/);
  });

  it('기존 파일(0644)을 덮어써도 0600으로 강제된다', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hoster-')), 'config.json');
    // writeFileSync의 mode 옵션은 파일 신규 생성 시에만 적용되므로,
    // 이미 0644로 존재하는 파일을 덮어쓰는 상황을 재현한다.
    writeFileSync(path, '{}', { mode: 0o644 });
    saveConfig(sample, path);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
