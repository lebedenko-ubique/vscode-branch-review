import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as git from './git';
import { ReviewStore } from './state';

export type ViewedState = 'unviewed' | 'viewed' | 'changed';

export interface ReviewFile extends git.ChangedFile {
  viewed: ViewedState;
}

const FALLBACK_BASES = ['main', 'master', 'origin/main', 'origin/master', 'develop'];

/** Holds the current comparison (repo, branch, base) and the list of changed files. */
export class ReviewModel implements vscode.Disposable {
  root: string | undefined;
  branch = '';
  /** The ref the user asked for (e.g. "main"). */
  baseRef = '';
  /** The commit actually diffed against (merge-base or the ref itself). */
  compareSha = '';
  compareShort = '';
  usingMergeBase = false;
  error: string | undefined;
  files: ReviewFile[] = [];

  private refreshing: Promise<void> | undefined;
  private pending = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(readonly store: ReviewStore) {}

  file(p: string): ReviewFile | undefined {
    return this.files.find((f) => f.path === p);
  }

  /** Coalesces concurrent refresh requests. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.pending = true;
      return this.refreshing;
    }
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = undefined;
      if (this.pending) {
        this.pending = false;
        void this.refresh();
      }
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    try {
      const root = await this.findRoot();
      if (!root) {
        this.root = undefined;
        this.files = [];
        this.error = undefined;
        return;
      }
      const branch = await git.currentBranch(root);
      if (root !== this.root || branch !== this.branch) {
        this.root = root;
        this.branch = branch;
        this.store.load(root, branch);
      }

      const cfg = vscode.workspace.getConfiguration('branchReview');
      const requested = this.store.base || cfg.get<string>('defaultBase', 'main');
      let baseRef = requested;
      if (!(await git.refExists(root, baseRef))) {
        baseRef = '';
        if (!this.store.base) {
          for (const candidate of FALLBACK_BASES) {
            if (await git.refExists(root, candidate)) {
              baseRef = candidate;
              break;
            }
          }
        }
      }
      if (!baseRef) {
        this.baseRef = requested;
        this.compareSha = '';
        this.files = [];
        this.error = `Base "${requested}" not found`;
        return;
      }
      this.baseRef = baseRef;

      const baseSha = await git.resolveRef(root, baseRef);
      let compare = baseSha;
      this.usingMergeBase = false;
      if (cfg.get<boolean>('useMergeBase', true)) {
        const mb = await git.mergeBase(root, baseSha, 'HEAD');
        if (mb) {
          compare = mb;
          this.usingMergeBase = mb !== baseSha;
        }
      }
      this.compareSha = compare;
      this.compareShort = await git.shortSha(root, compare);

      const changed = await git.changedFiles(root, compare, cfg.get<boolean>('includeUntracked', true));
      await this.countUntrackedLines(root, changed);
      const resetOnChange = cfg.get<boolean>('resetViewedOnChange', false);

      const files: ReviewFile[] = [];
      for (const f of changed) {
        const entry = this.store.getViewed(f.path);
        let viewed: ViewedState = 'unviewed';
        if (entry) {
          const hash = await this.hashFile(f.path, f.status);
          if (hash === entry.hash) {
            viewed = 'viewed';
          } else if (resetOnChange) {
            this.store.setViewed(f.path, undefined);
          } else {
            viewed = 'changed';
          }
        }
        files.push({ ...f, viewed });
      }
      this.files = files;
      this.error = undefined;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.files = [];
    } finally {
      this._onDidChange.fire();
    }
  }

  private async findRoot(): Promise<string | undefined> {
    if (this.root && (await git.findRepoRoot(this.root)) === this.root) {
      return this.root;
    }
    const folders = [...(vscode.workspace.workspaceFolders ?? [])];
    // Prefer the folder of the active editor in multi-root workspaces.
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    if (activeFolder) {
      folders.unshift(activeFolder);
    }
    for (const folder of folders) {
      const root = await git.findRepoRoot(folder.uri.fsPath);
      if (root) {
        return root;
      }
    }
    return undefined;
  }

  private async countUntrackedLines(root: string, files: git.ChangedFile[]): Promise<void> {
    await Promise.all(
      files
        .filter((f) => f.status === '?')
        .map(async (f) => {
          try {
            const full = path.join(root, f.path);
            const stat = await fs.stat(full);
            if (stat.size > 2 * 1024 * 1024) {
              return;
            }
            const buf = await fs.readFile(full);
            if (buf.includes(0)) {
              f.binary = true;
              return;
            }
            const text = buf.toString('utf8');
            f.additions = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
            f.deletions = 0;
          } catch {
            // ignore unreadable files
          }
        })
    );
  }

  /** Fingerprint of the file under review, used to detect changes after "viewed". */
  async hashFile(relPath: string, status?: string): Promise<string> {
    if (!this.root || status === 'D') {
      return 'deleted';
    }
    try {
      const buf = await fs.readFile(path.join(this.root, relPath));
      return crypto.createHash('sha1').update(buf).digest('hex');
    } catch {
      return 'missing';
    }
  }

  async markViewed(relPath: string, viewed: boolean): Promise<void> {
    const f = this.file(relPath);
    this.store.setViewed(relPath, viewed ? await this.hashFile(relPath, f?.status) : undefined);
    if (f) {
      f.viewed = viewed ? 'viewed' : 'unviewed';
    }
    this._onDidChange.fire();
  }

  /** The user saved a file they already marked as viewed: treat their own edit as reviewed. */
  async acceptOwnEdit(relPath: string): Promise<void> {
    const f = this.file(relPath);
    if (f && f.viewed === 'viewed') {
      this.store.setViewed(relPath, await this.hashFile(relPath, f.status));
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
