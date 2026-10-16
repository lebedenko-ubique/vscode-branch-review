import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/** Read-only documents with file contents at a given commit. */
export const BASE_SCHEME = 'branch-review-base';
/** Purely cosmetic URIs for tree items (file icon + status decoration). */
export const ITEM_SCHEME = 'branch-review-item';

export interface BaseQuery {
  /** Commit sha to read from. Empty => empty document (added / deleted side). */
  sha: string;
  /** Path of the file at `sha`. */
  path: string;
  /** Path of the file under review (working-tree path; differs for renames). */
  reviewPath: string;
}

export function baseUri(q: BaseQuery): vscode.Uri {
  // Keep the real file name in the URI path so language detection works.
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: '/' + (q.path || q.reviewPath), query: JSON.stringify(q) });
}

export function parseBaseUri(uri: vscode.Uri): BaseQuery | undefined {
  if (uri.scheme !== BASE_SCHEME) {
    return undefined;
  }
  try {
    return JSON.parse(uri.query) as BaseQuery;
  } catch {
    return undefined;
  }
}

export function itemUri(relPath: string, status: string): vscode.Uri {
  return vscode.Uri.from({ scheme: ITEM_SCHEME, path: '/' + relPath, query: status });
}

export function workingUri(root: string, relPath: string): vscode.Uri {
  return vscode.Uri.file(path.join(root, relPath));
}

/** Repo-relative path (forward slashes) for a file:// URI inside the repo, else undefined. */
export function relativeToRoot(root: string, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== 'file') {
    return undefined;
  }
  const toRel = (p: string) => {
    const rel = path.relative(root, p);
    return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel.split(path.sep).join('/');
  };
  const direct = toRel(uri.fsPath);
  if (direct !== undefined) {
    return direct;
  }
  // Workspace opened through a symlink (e.g. /tmp vs /private/tmp on macOS).
  try {
    return toRel(fs.realpathSync.native(uri.fsPath));
  } catch {
    return undefined;
  }
}
