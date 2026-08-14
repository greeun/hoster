import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface HosterConfig {
  nas: { host: string; port: number; user: string };
  cloudflare: { apiToken: string; zoneId: string; accountId: string; tunnelId: string };
  baseDomain: string;
  deployerUrl: string;
  hmacSecret: string;
  ghcrPat: string;
}

const DEFAULT_PATH = join(homedir(), '.hoster', 'config.json');

// NAS 접속 정보는 환경에 따라 다르므로 소스에 고정하지 않는다.
// HOSTER_NAS_HOST / HOSTER_NAS_PORT / HOSTER_NAS_USER로 지정하고,
// 없으면 아래 예시값을 기본으로 사용한다 (hoster init에서 확인 후 config.json에 저장됨).
export function defaultNas(): { host: string; port: number; user: string } {
  const port = Number(process.env.HOSTER_NAS_PORT ?? 22);
  return {
    host: process.env.HOSTER_NAS_HOST ?? '192.168.1.100',
    port: Number.isFinite(port) && port > 0 ? port : 22,
    user: process.env.HOSTER_NAS_USER ?? 'admin',
  };
}

export function loadConfig(path = DEFAULT_PATH): HosterConfig {
  if (!existsSync(path)) throw new Error(`설정 파일이 없습니다 (${path}). hoster init을 먼저 실행하세요.`);
  return JSON.parse(readFileSync(path, 'utf-8')) as HosterConfig;
}

export function saveConfig(cfg: HosterConfig, path = DEFAULT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // writeFileSync의 mode 옵션은 파일이 새로 생성될 때만 적용되므로,
  // 기존 파일(예: 이전 버전이 0644로 남긴 파일)을 덮어쓸 때도 0600을 강제한다.
  chmodSync(path, 0o600);
}
