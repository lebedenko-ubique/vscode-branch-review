import * as vscode from 'vscode';

export type FlagSide = 'working' | 'base';

export interface Flag {
  id: string;
  /** Repo-relative path. */
  path: string;
  /** 0-based start line. */
  line: number;
  /** 0-based inclusive end line. */
  endLine: number;
  side: FlagSide;
  note: string;
  /** Text of the first flagged line at the time of flagging (for display). */
  snippet: string;
  createdAt: number;
}

export interface ViewedEntry {
  /** Content hash of the working-tree file when it was marked viewed. */
  hash: string;
  at: number;
}

interface PersistedReview {
  base?: string;
  viewed: Record<string, ViewedEntry>;
  flags: Flag[];
}

/**
 * Persists review state per repository + branch in workspaceState, so switching
 * branches gives you a separate review.
 */
export class ReviewStore {
  private data: PersistedReview = { viewed: {}, flags: [] };
  private key = '';
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly memento: vscode.Memento) {}

  load(root: string, branch: string): void {
    this.flush();
    this.key = `branchReview:${root}:${branch}`;
    const stored = this.memento.get<PersistedReview>(this.key);
    this.data = {
      base: stored?.base,
      viewed: stored?.viewed ?? {},
      flags: stored?.flags ?? [],
    };
    this._onDidChange.fire();
  }

  get base(): string | undefined {
    return this.data.base;
  }

  set base(value: string | undefined) {
    this.data.base = value;
    this.changed();
  }

  // ---- viewed ----

  getViewed(path: string): ViewedEntry | undefined {
    return this.data.viewed[path];
  }

  setViewed(path: string, hash: string | undefined): void {
    if (hash === undefined) {
      delete this.data.viewed[path];
    } else {
      this.data.viewed[path] = { hash, at: Date.now() };
    }
    this.changed();
  }

  resetViewed(): void {
    this.data.viewed = {};
    this.changed();
  }

  // ---- flags ----

  get flags(): readonly Flag[] {
    return this.data.flags;
  }

  flagsFor(path: string, side?: FlagSide): Flag[] {
    return this.data.flags.filter((f) => f.path === path && (side === undefined || f.side === side));
  }

  addFlag(flag: Omit<Flag, 'id' | 'createdAt'>): Flag {
    const full: Flag = { ...flag, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now() };
    this.data.flags.push(full);
    this.changed();
    return full;
  }

  updateFlag(id: string, patch: Partial<Flag>): void {
    const f = this.data.flags.find((x) => x.id === id);
    if (f) {
      Object.assign(f, patch);
      this.changed();
    }
  }

  removeFlag(id: string): void {
    this.data.flags = this.data.flags.filter((f) => f.id !== id);
    this.changed();
  }

  clearFlags(): void {
    this.data.flags = [];
    this.changed();
  }

  /** Mutated flag lines in place (from edit tracking); persists without a tree refresh storm. */
  flagsMoved(): void {
    this.changed();
  }

  private changed(): void {
    this._onDidChange.fire();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.key) {
      void this.memento.update(this.key, this.data);
    }
  }

  dispose(): void {
    this.flush();
    this._onDidChange.dispose();
  }
}
