import { execFile } from 'child_process';

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface ChangedFile {
  /** Repo-relative path in the working tree (new path for renames). */
  path: string;
  /** Repo-relative path on the base side (differs from `path` for renames/copies). */
  oldPath: string;
  status: ChangeStatus;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export class GitError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
  }
}

export function git(cwd: string, args: string[], opts: { trim?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout, stderr) => {
        if (err) {
          reject(new GitError(`git ${args.join(' ')} failed: ${stderr || err.message}`, stderr));
          return;
        }
        resolve(opts.trim === false ? stdout : stdout.trim());
      }
    );
  });
}

export async function findRepoRoot(dir: string): Promise<string | undefined> {
  try {
    return await git(dir, ['rev-parse', '--show-toplevel']);
  } catch {
    return undefined;
  }
}

export async function currentBranch(root: string): Promise<string> {
  try {
    return await git(root, ['symbolic-ref', '--short', 'HEAD']);
  } catch {
    // Detached HEAD
    try {
      return 'detached@' + (await git(root, ['rev-parse', '--short', 'HEAD']));
    } catch {
      return 'no-commits';
    }
  }
}

export async function refExists(root: string, ref: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRef(root: string, ref: string): Promise<string> {
  return git(root, ['rev-parse', '--verify', ref + '^{commit}']);
}

export async function mergeBase(root: string, a: string, b: string): Promise<string | undefined> {
  try {
    return await git(root, ['merge-base', a, b]);
  } catch {
    return undefined;
  }
}

export async function shortSha(root: string, sha: string): Promise<string> {
  try {
    return await git(root, ['rev-parse', '--short', sha]);
  } catch {
    return sha.slice(0, 7);
  }
}

export interface RefInfo {
  name: string;
  kind: 'branch' | 'remote' | 'tag' | 'commit';
  detail?: string;
}

export async function listRefs(root: string): Promise<RefInfo[]> {
  const out = await git(root, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)%09%(refname:short)%09%(committerdate:relative)%09%(subject)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);
  const refs: RefInfo[] = [];
  for (const line of out.split('\n')) {
    if (!line) {
      continue;
    }
    const [full, short, date, subject] = line.split('\t');
    if (full.endsWith('/HEAD')) {
      continue;
    }
    const kind = full.startsWith('refs/heads/') ? 'branch' : full.startsWith('refs/remotes/') ? 'remote' : 'tag';
    refs.push({ name: short, kind, detail: `${date} · ${subject ?? ''}` });
  }
  return refs;
}

export async function recentCommits(root: string, count = 30): Promise<RefInfo[]> {
  try {
    const out = await git(root, ['log', `-${count}`, '--format=%h%x09%cr%x09%an%x09%s']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, date, author, subject] = line.split('\t');
        return { name: sha, kind: 'commit' as const, detail: `${subject} · ${author}, ${date}` };
      });
  } catch {
    return [];
  }
}

/**
 * All changes between `baseSha` and the working tree: committed on the branch,
 * staged and unstaged. Optionally includes untracked files.
 */
export async function changedFiles(root: string, baseSha: string, includeUntracked: boolean): Promise<ChangedFile[]> {
  const [nameStatus, numstat, untracked] = await Promise.all([
    git(root, ['diff', '--name-status', '-z', '-M', baseSha, '--'], { trim: false }),
    git(root, ['diff', '--numstat', '-z', '-M', baseSha, '--'], { trim: false }),
    includeUntracked
      ? git(root, ['ls-files', '--others', '--exclude-standard', '-z'], { trim: false })
      : Promise.resolve(''),
  ]);

  const files = new Map<string, ChangedFile>();

  // --name-status -z: "M\0path\0" or "R100\0old\0new\0"
  const ns = nameStatus.split('\0');
  for (let i = 0; i < ns.length; ) {
    const code = ns[i++];
    if (!code) {
      continue;
    }
    const status = code[0] as ChangeStatus;
    if (status === 'R' || status === 'C') {
      const oldPath = ns[i++];
      const newPath = ns[i++];
      files.set(newPath, { path: newPath, oldPath, status });
    } else {
      const p = ns[i++];
      files.set(p, { path: p, oldPath: p, status });
    }
  }

  // --numstat -z: "add\tdel\tpath\0" or "add\tdel\t\0old\0new\0"
  const nm = numstat.split('\0');
  for (let i = 0; i < nm.length; ) {
    const entry = nm[i++];
    if (!entry) {
      continue;
    }
    const [add, del, p] = entry.split('\t');
    let path = p;
    if (!path) {
      i++; // old path
      path = nm[i++];
    }
    const f = files.get(path);
    if (f) {
      if (add === '-' || del === '-') {
        f.binary = true;
      } else {
        f.additions = Number(add);
        f.deletions = Number(del);
      }
    }
  }

  for (const p of untracked.split('\0')) {
    if (p && !files.has(p)) {
      files.set(p, { path: p, oldPath: p, status: '?' });
    }
  }

  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function showFile(root: string, sha: string, path: string): Promise<string> {
  try {
    return await git(root, ['show', `${sha}:${path}`], { trim: false });
  } catch {
    return '';
  }
}
