import * as vscode from 'vscode';
import * as path from 'path';
import { ReviewModel, ReviewFile } from './review';
import { Flag } from './state';
import { ITEM_SCHEME, itemUri } from './uris';

export type Node =
  | { kind: 'base' }
  | { kind: 'error'; message: string }
  | { kind: 'group'; group: 'unviewed' | 'viewed' | 'flagged' }
  | { kind: 'file'; file: ReviewFile }
  | { kind: 'flag'; flag: Flag };

export class ReviewTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly model: ReviewModel) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  unviewedFiles(): ReviewFile[] {
    return this.model.files.filter((f) => f.viewed === 'unviewed');
  }

  viewedFiles(): ReviewFile[] {
    return this.model.files.filter((f) => f.viewed !== 'unviewed');
  }

  sortedFlags(): Flag[] {
    return [...this.model.store.flags].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }

  getChildren(node?: Node): Node[] {
    if (!this.model.root) {
      return [];
    }
    if (!node) {
      const nodes: Node[] = [{ kind: 'base' }];
      if (this.model.error) {
        nodes.push({ kind: 'error', message: this.model.error });
      }
      nodes.push({ kind: 'group', group: 'flagged' }, { kind: 'group', group: 'unviewed' }, { kind: 'group', group: 'viewed' });
      return nodes;
    }
    if (node.kind === 'group') {
      switch (node.group) {
        case 'unviewed':
          return this.unviewedFiles().map((file) => ({ kind: 'file', file }));
        case 'viewed':
          return this.viewedFiles().map((file) => ({ kind: 'file', file }));
        case 'flagged':
          return this.sortedFlags().map((flag) => ({ kind: 'flag', flag }));
      }
    }
    return [];
  }

  getParent(node: Node): Node | undefined {
    if (node.kind === 'file') {
      return { kind: 'group', group: node.file.viewed === 'unviewed' ? 'unviewed' : 'viewed' };
    }
    if (node.kind === 'flag') {
      return { kind: 'group', group: 'flagged' };
    }
    return undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'base': {
        const m = this.model;
        const item = new vscode.TreeItem(`Base: ${m.baseRef || '?'}`, vscode.TreeItemCollapsibleState.None);
        item.id = 'base';
        item.iconPath = new vscode.ThemeIcon('git-compare');
        item.description = m.compareShort
          ? m.usingMergeBase
            ? `merge-base ${m.compareShort}`
            : m.compareShort
          : '';
        item.tooltip = new vscode.MarkdownString(
          `Comparing **${m.branch}** (incl. staged, unstaged${vscode.workspace.getConfiguration('branchReview').get('includeUntracked', true) ? ', untracked' : ''}) ` +
            `against **${m.baseRef}**${m.usingMergeBase ? ` (merge-base \`${m.compareShort}\`)` : ''}.\n\nClick to change.`
        );
        item.command = { command: 'branchReview.changeBase', title: 'Change Base' };
        item.contextValue = 'base';
        return item;
      }
      case 'error': {
        const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
        item.id = 'error';
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        item.tooltip = node.message;
        item.command = { command: 'branchReview.changeBase', title: 'Change Base' };
        return item;
      }
      case 'group': {
        const counts = {
          unviewed: this.unviewedFiles().length,
          viewed: this.viewedFiles().length,
          flagged: this.model.store.flags.length,
        };
        const labels = { unviewed: 'Unreviewed', viewed: 'Viewed', flagged: 'Flagged' };
        const icons = { unviewed: 'eye-closed', viewed: 'eye', flagged: 'flag' };
        const n = counts[node.group];
        const item = new vscode.TreeItem(
          labels[node.group],
          n === 0
            ? vscode.TreeItemCollapsibleState.None
            : node.group === 'viewed'
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.Expanded
        );
        // Including the emptiness in the id resets the expansion state when a group goes from empty to non-empty.
        item.id = `group:${node.group}:${n === 0 ? 'empty' : 'items'}`;
        item.description = String(n);
        item.iconPath = new vscode.ThemeIcon(icons[node.group]);
        item.contextValue = `group.${node.group}`;
        return item;
      }
      case 'file': {
        const f = node.file;
        const item = new vscode.TreeItem(itemUri(f.path, f.status), vscode.TreeItemCollapsibleState.None);
        item.id = `file:${f.viewed === 'unviewed' ? 'u' : 'v'}:${f.path}`;
        item.label = path.posix.basename(f.path);
        const dir = path.posix.dirname(f.path);
        const parts: string[] = [];
        if (dir !== '.') {
          parts.push(dir);
        }
        if (f.binary) {
          parts.push('binary');
        } else if (f.additions !== undefined) {
          parts.push(`+${f.additions} −${f.deletions ?? 0}`);
        }
        const flagCount = this.model.store.flagsFor(f.path).length;
        if (flagCount) {
          parts.push(`⚑${flagCount}`);
        }
        if (f.viewed === 'changed') {
          parts.push('• changed since viewed');
        }
        item.description = parts.join('  ');
        const statusText: Record<string, string> = {
          A: 'Added',
          M: 'Modified',
          D: 'Deleted',
          R: 'Renamed',
          C: 'Copied',
          T: 'Type changed',
          U: 'Unmerged',
          '?': 'Untracked',
        };
        item.tooltip = `${f.path}${f.oldPath !== f.path ? `\n(from ${f.oldPath})` : ''}\n${statusText[f.status] ?? f.status}`;
        item.command = { command: 'branchReview.openDiff', title: 'Open Diff', arguments: [node] };
        item.contextValue = f.viewed === 'unviewed' ? 'file.unviewed' : 'file.viewed';
        return item;
      }
      case 'flag': {
        const fl = node.flag;
        const lines = fl.endLine > fl.line ? `${fl.line + 1}-${fl.endLine + 1}` : `${fl.line + 1}`;
        const item = new vscode.TreeItem(`${path.posix.basename(fl.path)}:${lines}`, vscode.TreeItemCollapsibleState.None);
        item.id = `flag:${fl.id}`;
        item.description = fl.note || fl.snippet.trim();
        item.iconPath = new vscode.ThemeIcon('flag', new vscode.ThemeColor('charts.orange'));
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${fl.path}:${lines}**${fl.side === 'base' ? ' _(base side)_' : ''}\n\n`);
        if (fl.note) {
          md.appendText(fl.note);
          md.appendMarkdown('\n\n');
        }
        if (fl.snippet.trim()) {
          md.appendCodeblock(fl.snippet, '');
        }
        item.tooltip = md;
        item.command = { command: 'branchReview.goToFlag', title: 'Go to Flag', arguments: [node] };
        item.contextValue = 'flag';
        return item;
      }
    }
  }
}

const STATUS_COLORS: Record<string, string> = {
  A: 'gitDecoration.addedResourceForeground',
  M: 'gitDecoration.modifiedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
  C: 'gitDecoration.addedResourceForeground',
  T: 'gitDecoration.modifiedResourceForeground',
  U: 'gitDecoration.conflictingResourceForeground',
  '?': 'gitDecoration.untrackedResourceForeground',
};

/** Status letter + color for items in the review tree only. */
export class ItemDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== ITEM_SCHEME) {
      return undefined;
    }
    const status = uri.query;
    const badge = status === '?' ? 'U' : status;
    return new vscode.FileDecoration(badge, undefined, new vscode.ThemeColor(STATUS_COLORS[status] ?? 'foreground'));
  }
}
