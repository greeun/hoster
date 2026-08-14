import Database from 'better-sqlite3';

export interface ProjectInput {
  name: string; imageRepo: string; domain: string;
  branch: string; healthPath: string; containerPort: number;
}
export interface Project extends ProjectInput {
  currentImage: string | null; previousImage: string | null;
}
export interface Deployment {
  id: number; project: string; image: string; sha: string;
  status: string; error: string | null; createdAt: string;
}

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        name TEXT PRIMARY KEY, image_repo TEXT NOT NULL, domain TEXT NOT NULL,
        branch TEXT NOT NULL, health_path TEXT NOT NULL, container_port INTEGER NOT NULL,
        current_image TEXT, previous_image TEXT
      );
      CREATE TABLE IF NOT EXISTS deployments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL, image TEXT NOT NULL, sha TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  upsertProject(p: ProjectInput): void {
    this.db.prepare(`
      INSERT INTO projects (name, image_repo, domain, branch, health_path, container_port)
      VALUES (@name, @imageRepo, @domain, @branch, @healthPath, @containerPort)
      ON CONFLICT(name) DO UPDATE SET
        image_repo=@imageRepo, domain=@domain, branch=@branch,
        health_path=@healthPath, container_port=@containerPort
    `).run(p as unknown as Record<string, unknown>);
  }

  getProject(name: string): Project | undefined {
    const r = this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    return r ? this.rowToProject(r) : undefined;
  }

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY name').all() as Record<string, unknown>[])
      .map((r) => this.rowToProject(r));
  }

  removeProject(name: string): void {
    this.db.prepare('DELETE FROM projects WHERE name = ?').run(name);
  }

  setImages(name: string, current: string | null, previous: string | null): void {
    this.db.prepare('UPDATE projects SET current_image = ?, previous_image = ? WHERE name = ?')
      .run(current, previous, name);
  }

  recordDeployment(d: { project: string; image: string; sha: string }): number {
    const res = this.db.prepare(
      'INSERT INTO deployments (project, image, sha) VALUES (@project, @image, @sha)'
    ).run(d);
    return Number(res.lastInsertRowid);
  }

  updateDeploymentStatus(id: number, status: 'pending' | 'success' | 'failed' | 'rolled_back', error?: string): void {
    this.db.prepare('UPDATE deployments SET status = ?, error = ? WHERE id = ?')
      .run(status, error ?? null, id);
  }

  listDeployments(project: string, limit = 20): Deployment[] {
    return (this.db.prepare(
      'SELECT id, project, image, sha, status, error, created_at AS createdAt FROM deployments WHERE project = ? ORDER BY id DESC LIMIT ?'
    ).all(project, limit)) as Deployment[];
  }

  private rowToProject(r: Record<string, unknown>): Project {
    return {
      name: r.name as string, imageRepo: r.image_repo as string, domain: r.domain as string,
      branch: r.branch as string, healthPath: r.health_path as string,
      containerPort: r.container_port as number,
      currentImage: (r.current_image as string) ?? null,
      previousImage: (r.previous_image as string) ?? null,
    };
  }
}
