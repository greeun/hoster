import { signPayload } from './hmac.js';

export class DeployerClient {
  private baseUrl: string;
  private secret: string;
  private fetchFn: typeof fetch;
  private now: () => number;

  constructor(opts: {
    baseUrl: string;
    secret: string;
    fetchFn?: typeof fetch;
    now?: () => number;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.secret = opts.secret;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = this.now();
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-hoster-timestamp': String(ts),
        'x-hoster-signature': signPayload(raw, ts, this.secret),
      },
      ...(raw ? { body: raw } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`deployer 응답 ${res.status}: ${text}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  deploy(p: { project: string; image: string; sha: string }) {
    return this.request('POST', '/deploy', p);
  }

  registerProject(p: {
    name: string;
    imageRepo: string;
    branch: string;
    containerPort?: number;
    healthPath?: string;
  }) {
    return this.request('POST', '/projects', p);
  }

  removeProject(name: string) {
    return this.request('DELETE', `/projects/${name}`);
  }

  status() {
    return this.request('GET', '/status');
  }

  statusOf(project: string) {
    return this.request('GET', `/status/${project}`);
  }

  logs(project: string, tail = 200): Promise<string> {
    return this.request<string>('GET', `/logs/${project}?tail=${tail}`);
  }

  rollback(project: string) {
    return this.request('POST', `/rollback/${project}`);
  }

  env(
    project: string,
    body: { set?: Record<string, string>; remove?: string[] }
  ) {
    return this.request('PUT', `/env/${project}`, body);
  }
}
