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

export function loadConfig(path = DEFAULT_PATH): HosterConfig {
  if (!existsSync(path)) throw new Error(`설정 파일이 없습니다 (${path}). hoster init을 먼저 실행하세요.`);
  return JSON.parse(readFileSync(path, 'utf-8')) as HosterConfig;
}

// hoster init 재실행용 — 설정이 없으면(최초 실행) undefined, 있으면 프롬프트 기본값과
// 비대화형 폴백으로 쓴다. 손상된 파일 때문에 최초 설치가 막히지 않도록, 읽거나 파싱하지
// 못하면 "없음"으로 간주하고 계속 진행한다(값은 다시 입력받게 된다).
export function loadConfigIfExists(path = DEFAULT_PATH): HosterConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as HosterConfig;
  } catch {
    return undefined;
  }
}

export function saveConfig(cfg: HosterConfig, path = DEFAULT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // writeFileSync의 mode 옵션은 파일이 새로 생성될 때만 적용되므로,
  // 기존 파일(예: 이전 버전이 0644로 남긴 파일)을 덮어쓸 때도 0600을 강제한다.
  chmodSync(path, 0o600);
}
