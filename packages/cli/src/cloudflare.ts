const BASE = 'https://api.cloudflare.com/client/v4';

interface ApiEnvelope<T> {
  success: boolean;
  result: T;
  errors?: { message: string }[];
}

export interface TunnelSummary {
  id: string;
  name: string;
  /** 현재 붙어있는 cloudflared 커넥션 수 — 0이 아니면 다른 곳에서 사용 중일 수 있다. */
  connections: number;
}

export class Cloudflare {
  private apiToken: string;
  private accountId: string;
  private zoneId: string;
  private fetchFn: typeof fetch;

  constructor(opts: { apiToken: string; accountId: string; zoneId: string; fetchFn?: typeof fetch }) {
    this.apiToken = opts.apiToken;
    this.accountId = opts.accountId;
    this.zoneId = opts.zoneId;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchFn(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'content-type': 'application/json',
        ...init?.headers,
      },
    });

    // 프록시 장애 등으로 502/504 HTML 응답이 올 수 있다. JSON 파싱 실패를 그대로
    // 던지면 원인을 알기 어려우므로, 상태 코드를 포함한 명확한 에러로 변환한다.
    // (API 토큰은 요청 헤더에만 존재하므로 여기서는 노출되지 않는다.)
    let json: ApiEnvelope<T>;
    try {
      json = (await res.json()) as ApiEnvelope<T>;
    } catch {
      throw new Error(`Cloudflare API 응답을 파싱할 수 없습니다 (status ${res.status})`);
    }

    if (!json.success) {
      throw new Error(`Cloudflare API 실패: ${json.errors?.map((e) => e.message).join(', ')}`);
    }
    return json.result;
  }

  async createTunnel(name: string): Promise<{ id: string; token: string }> {
    const created = await this.api<{ id: string }>(`/accounts/${this.accountId}/cfd_tunnel`, {
      method: 'POST',
      body: JSON.stringify({ name, config_src: 'cloudflare' }),
    });
    const token = await this.getTunnelToken(created.id);
    return { id: created.id, token };
  }

  // 터널 생성 전에 같은 이름의 터널이 이미 있는지 확인한다 — 사용자가 대시보드를 열지 않고도
  // 재사용/삭제를 선택할 수 있게 하기 위한 조회. name은 서버 측 필터이므로 결과는 0/1건이고,
  // is_deleted=false로 삭제 대기 상태의 터널은 제외한다(이름 충돌을 일으키지 않음).
  async findTunnelByName(name: string): Promise<TunnelSummary | undefined> {
    const params = new URLSearchParams({ name, is_deleted: 'false' });
    const found = await this.api<{ id: string; name: string; connections?: unknown[] }[]>(
      `/accounts/${this.accountId}/cfd_tunnel?${params.toString()}`
    );
    const t = found[0];
    if (!t) return undefined;
    return { id: t.id, name: t.name, connections: t.connections?.length ?? 0 };
  }

  async deleteTunnel(tunnelId: string): Promise<void> {
    await this.api(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}`, { method: 'DELETE' });
  }

  // 이미 존재하는 터널을 재사용할 때(예: `hoster init --reuse-tunnel <id>`) 이름 충돌
  // 없이 토큰만 다시 조회한다.
  async getTunnelToken(tunnelId: string): Promise<string> {
    return this.api<string>(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/token`);
  }

  async setTunnelIngress(tunnelId: string, rules: { hostname: string; service: string }[]): Promise<void> {
    await this.api(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: 'PUT',
      body: JSON.stringify({ config: { ingress: [...rules, { service: 'http_status:404' }] } }),
    });
  }

  // Cloudflare DNS 레코드 목록 조회는 페이지네이션되지만, name 쿼리 파라미터는
  // name.exact의 동의어로 서버 측에서 정확히 일치하는 레코드만 걸러준다.
  // 따라서 클라이언트에서 페이지를 순회할 필요 없이 결과는 항상 0건 또는 1건이다.
  private async findDnsRecord(name: string, type?: string): Promise<{ id: string } | undefined> {
    const params = new URLSearchParams({ name });
    if (type) params.set('type', type);
    const existing = await this.api<{ id: string }[]>(`/zones/${this.zoneId}/dns_records?${params.toString()}`);
    return existing[0];
  }

  async upsertDnsCname(name: string, target: string): Promise<void> {
    const record = { type: 'CNAME', name, content: target, proxied: true };
    const existing = await this.findDnsRecord(name, 'CNAME');
    if (existing) {
      await this.api(`/zones/${this.zoneId}/dns_records/${existing.id}`, {
        method: 'PUT',
        body: JSON.stringify(record),
      });
    } else {
      await this.api(`/zones/${this.zoneId}/dns_records`, {
        method: 'POST',
        body: JSON.stringify(record),
      });
    }
  }

  async deleteDnsRecord(name: string): Promise<void> {
    // upsertDnsCname과 동일하게 type=CNAME으로 좁혀야 한다 — 타입 필터 없이 이름만으로
    // 찾으면 같은 이름의 다른 타입 레코드(예: TXT)를 대신 지우고 정작 지워야 할 CNAME은
    // 그대로 남길 수 있다.
    const existing = await this.findDnsRecord(name, 'CNAME');
    if (!existing) return;
    await this.api(`/zones/${this.zoneId}/dns_records/${existing.id}`, { method: 'DELETE' });
  }
}
