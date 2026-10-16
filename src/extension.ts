import * as vscode from 'vscode';
import * as path from 'path';
import * as git from './git';
import { ReviewModel, ReviewFile } from './review';
import { ReviewStore, Flag } from './state';
import { ReviewTreeProvider, ItemDecorationProvider, Node } from './tree';
import { FlagDecorator, flagsAt, targetFor } from './flags';
import { BASE_SCHEME, baseUri, parseBaseUri, relativeToRoot, workingUri } from './uris';

export function activate(context: vscode.ExtensionContext): void {
  const store = new ReviewStore(context.workspaceState);
  const model = new ReviewModel(store);
  const tree = new ReviewTreeProvider(model);
  const decorator = new FlagDecorator(model, context.extensionUri);
  const view = vscode.window.createTreeView('branchReview.files', { treeDataProvider: tree, showCollapseAll: true });

  context.subscriptions.push(store, model, decorator, view);

  // ---------- base content provider ----------
  // URIs embed the commit sha, so their content never changes.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, {
      provideTextDocumentContent: async (uri) => {
        const q = parseBaseUri(uri);
        if (!q || !q.sha || !model.root) {
          return '';
        }
        return git.showFile(model.root, q.sha, q.path);
      },
    }),
    vscode.window.registerFileDecorationProvider(new ItemDecorationProvider())
  );

  // ---------- view state ----------
  const updateView = () => {
    tree.refresh();
    const left = tree.unviewedFiles().length;
    const total = model.files.length;
    view.badge = left ? { value: left, tooltip: `${left} file(s) left to review` } : undefined;
    view.description = model.root ? `${model.branch} · ${total - left}/${total} viewed` : undefined;
    void vscode.commands.executeCommand('setContext', 'branchReview.hasRepo', !!model.root);
    updateEditorContext();
    decorator.render();
  };
  context.subscriptions.push(model.onDidChange(updateView), store.onDidChange(() => tree.refresh()));

  // ---------- helpers ----------

  /** The review file shown in the active diff tab, if it's one of ours. */
  const activeReviewPath = (): string | undefined => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) {
      return parseBaseUri(input.original)?.reviewPath;
    }
    return undefined;
  };

  /** Resolve a review path from a tree node, a URI or the active editor. */
  const resolvePath = (arg: unknown): string | undefined => {
    if (isNode(arg) && arg.kind === 'file') {
      return arg.file.path;
    }
    if (arg instanceof vscode.Uri) {
      const fromBase = parseBaseUri(arg)?.reviewPath;
      if (fromBase) {
        return fromBase;
      }
      if (model.root) {
        const rel = relativeToRoot(model.root, arg);
        if (rel) {
          return rel;
        }
      }
    }
    const fromTab = activeReviewPath();
    if (fromTab) {
      return fromTab;
    }
    const doc = vscode.window.activeTextEditor?.document;
    return doc ? targetFor(model, doc.uri)?.path : undefined;
  };

  function updateEditorContext() {
    const p = activeReviewPath();
    const f = p ? model.file(p) : undefined;
    void vscode.commands.executeCommand('setContext', 'branchReview.inReviewDiff', !!p);
    void vscode.commands.executeCommand('setContext', 'branchReview.activeViewed', !!f && f.viewed !== 'unviewed');
    const editor = vscode.window.activeTextEditor;
    const flagged = !!editor && flagsAt(model, editor.document.uri, editor.selection.active.line).length > 0;
    void vscode.commands.executeCommand('setContext', 'branchReview.lineFlagged', flagged);
  }

  const openDiff = async (file: ReviewFile, reveal?: { line: number; endLine: number; side: 'working' | 'base' }) => {
    if (!model.root) {
      return;
    }
    const addedLike = file.status === 'A' || file.status === '?';
    const left = baseUri({ sha: addedLike ? '' : model.compareSha, path: addedLike ? '' : file.oldPath, reviewPath: file.path });
    const right =
      file.status === 'D'
        ? baseUri({ sha: '', path: '', reviewPath: file.path })
        : workingUri(model.root, file.path);
    const name = path.posix.basename(file.path);
    const title = `${name} (${model.baseRef} ↔ Working Tree)`;
    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (reveal && reveal.side === 'working') {
      options.selection = new vscode.Range(reveal.line, 0, reveal.line, 0);
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, title, options);
    if (reveal && reveal.side === 'base') {
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === left.toString());
      if (editor) {
        const r = new vscode.Range(reveal.line, 0, reveal.endLine, 0);
        editor.selection = new vscode.Selection(r.start, r.start);
        editor.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }
    updateEditorContext();
  };

  const openNextUnreviewed = async (after?: string) => {
    const all = model.files;
    const unviewed = tree.unviewedFiles();
    if (unviewed.length === 0) {
      void vscode.window.showInformationMessage('Branch Review: all files viewed 🎉');
      return;
    }
    let next = unviewed[0];
    if (after) {
      const idx = all.findIndex((f) => f.path === after);
      next = all.slice(idx + 1).find((f) => f.viewed === 'unviewed') ?? unviewed[0];
    }
    await openDiff(next);
    void view.reveal({ kind: 'file', file: next }, { select: true, focus: false }).then(undefined, () => undefined);
  };

  const editNote = async (initial: string) =>
    vscode.window.showInputBox({
      title: 'Flag for review',
      prompt: 'Note (optional) — Enter to save, Esc to cancel',
      value: initial,
      placeHolder: 'e.g. "is this null-safe?"',
    });

  // ---------- refresh triggers ----------
  let timer: NodeJS.Timeout | undefined;
  const scheduleRefresh = (delay = 400) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => void model.refresh(), delay);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(() => scheduleRefresh()),
    watcher.onDidCreate(() => scheduleRefresh()),
    watcher.onDidDelete(() => scheduleRefresh()),
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const rel = model.root ? relativeToRoot(model.root, doc.uri) : undefined;
      if (rel) {
        await model.acceptOwnEdit(rel);
      }
      scheduleRefresh(100);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRefresh(0)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('branchReview')) {
        scheduleRefresh(0);
      }
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => updateEditorContext()),
    vscode.window.onDidChangeActiveTextEditor(() => updateEditorContext()),
    vscode.window.onDidChangeTextEditorSelection(() => updateEditorContext()),
    { dispose: () => timer && clearTimeout(timer) }
  );

  // ---------- commands ----------
  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('branchReview.refresh', () => model.refresh());

  reg('branchReview.changeBase', async () => {
    if (!model.root) {
      return;
    }
    const root = model.root;
    const defaultBase = vscode.workspace.getConfiguration('branchReview').get<string>('defaultBase', 'main');
    type Item = vscode.QuickPickItem & { ref?: string };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'Compare against branch, tag or commit';
    qp.placeholder = 'Type to filter, or enter any ref / sha (e.g. origin/main, HEAD~3, a1b2c3d)';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.busy = true;
    qp.show();

    const [refs, commits] = await Promise.all([git.listRefs(root).catch(() => []), git.recentCommits(root)]);
    const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const base: Item[] = [
      {
        label: `$(home) Default (${defaultBase})`,
        description: store.base ? '' : 'current',
        ref: '',
      },
    ];
    const toItem = (r: git.RefInfo, icon: string): Item => ({
      label: `$(${icon}) ${r.name}`,
      description: r.name === model.baseRef && store.base ? 'current' : undefined,
      detail: r.detail,
      ref: r.name,
    });
    const branches = refs.filter((r) => r.kind === 'branch').map((r) => toItem(r, 'git-branch'));
    const remotes = refs.filter((r) => r.kind === 'remote').map((r) => toItem(r, 'cloud'));
    const tags = refs.filter((r) => r.kind === 'tag').map((r) => toItem(r, 'tag'));
    const recent = commits.map((r) => toItem(r, 'git-commit'));
    const staticItems: Item[] = [
      ...base,
      ...(branches.length ? [sep('Branches'), ...branches] : []),
      ...(remotes.length ? [sep('Remote branches'), ...remotes] : []),
      ...(recent.length ? [sep('Recent commits on this branch'), ...recent] : []),
      ...(tags.length ? [sep('Tags'), ...tags] : []),
    ];
    qp.items = staticItems;
    qp.busy = false;

    qp.onDidChangeValue((value) => {
      const v = value.trim();
      const exact = staticItems.some((i) => i.ref === v);
      qp.items = v && !exact ? [{ label: `$(edit) Use "${v}"`, description: 'custom ref', ref: v, alwaysShow: true }, ...staticItems] : staticItems;
    });

    const picked = await new Promise<Item | undefined>((resolve) => {
      qp.onDidAccept(() => resolve(qp.selectedItems[0]));
      qp.onDidHide(() => resolve(undefined));
    });
    qp.dispose();
    if (!picked || picked.ref === undefined) {
      return;
    }
    if (picked.ref && !(await git.refExists(root, picked.ref))) {
      void vscode.window.showErrorMessage(`Branch Review: "${picked.ref}" is not a valid branch, tag or commit.`);
      return;
    }
    store.base = picked.ref || undefined;
    await model.refresh();
  });

  reg('branchReview.openDiff', (arg?: Node) => {
    if (isNode(arg) && arg.kind === 'file') {
      return openDiff(arg.file);
    }
  });

  reg('branchReview.openFile', async (arg?: unknown) => {
    const p = resolvePath(arg);
    if (!p || !model.root) {
      return;
    }
    if (model.file(p)?.status === 'D') {
      void vscode.window.showInformationMessage('This file was deleted on the branch.');
      return;
    }
    await vscode.window.showTextDocument(workingUri(model.root, p), { preview: false });
  });

  reg('branchReview.markViewed', async (arg?: unknown) => {
    const p = resolvePath(arg);
    if (p) {
      await model.markViewed(p, true);
    }
  });

  reg('branchReview.markUnviewed', async (arg?: unknown) => {
    const p = resolvePath(arg);
    if (p) {
      await model.markViewed(p, false);
    }
  });

  reg('branchReview.markViewedAndNext', async (arg?: unknown) => {
    const p = resolvePath(arg);
    if (p) {
      await model.markViewed(p, true);
    }
    await openNextUnreviewed(p);
  });

  reg('branchReview.nextFile', () => openNextUnreviewed(activeReviewPath()));

  reg('branchReview.flagLine', async (arg?: unknown) => {
    const editor = vscode.window.activeTextEditor;
    let uri: vscode.Uri | undefined;
    let line: number;
    let endLine: number;
    // From the line-number gutter menu: { lineNumber (1-based), uri }
    if (isLineArg(arg)) {
      uri = arg.uri;
      line = endLine = arg.lineNumber - 1;
      if (editor && editor.document.uri.toString() === uri.toString()) {
        const sel = editor.selection;
        if (!sel.isEmpty && line >= sel.start.line && line <= sel.end.line) {
          line = sel.start.line;
          endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
        }
      }
    } else if (editor) {
      uri = editor.document.uri;
      const sel = editor.selection;
      line = sel.start.line;
      endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
    } else {
      return;
    }
    if (!model.root) {
      return;
    }
    const target = targetFor(model, uri);
    if (!target) {
      void vscode.window.showWarningMessage('Branch Review: can only flag files inside the repository.');
      return;
    }

    const existing = flagsAt(model, uri, line)[0];
    if (existing) {
      const note = await editNote(existing.note);
      if (note !== undefined) {
        store.updateFlag(existing.id, { note });
      }
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const snippetLines: string[] = [];
    for (let l = line; l <= Math.min(endLine, line + 4, doc.lineCount - 1); l++) {
      snippetLines.push(doc.lineAt(l).text);
    }
    const note = await editNote('');
    if (note === undefined) {
      return;
    }
    store.addFlag({ path: target.path, side: target.side, line, endLine, note, snippet: snippetLines.join('\n') });
  });

  reg('branchReview.unflagLine', (arg?: unknown) => {
    const editor = vscode.window.activeTextEditor;
    let uri: vscode.Uri | undefined;
    let line: number;
    if (isLineArg(arg)) {
      uri = arg.uri;
      line = arg.lineNumber - 1;
    } else if (editor) {
      uri = editor.document.uri;
      line = editor.selection.active.line;
    } else {
      return;
    }
    const flags = flagsAt(model, uri, line);
    if (flags.length === 0) {
      void vscode.window.setStatusBarMessage('Branch Review: no flag on this line', 2000);
    }
    flags.forEach((f) => store.removeFlag(f.id));
  });

  reg('branchReview.editFlag', async (arg?: Node) => {
    if (isNode(arg) && arg.kind === 'flag') {
      const note = await editNote(arg.flag.note);
      if (note !== undefined) {
        store.updateFlag(arg.flag.id, { note });
      }
    }
  });

  reg('branchReview.removeFlag', (arg?: Node) => {
    if (isNode(arg) && arg.kind === 'flag') {
      store.removeFlag(arg.flag.id);
    }
  });

  reg('branchReview.goToFlag', async (arg?: Node) => {
    if (!isNode(arg) || arg.kind !== 'flag' || !model.root) {
      return;
    }
    const f = arg.flag;
    const file = model.file(f.path);
    if (file) {
      await openDiff(file, f);
    } else {
      // File no longer differs from base: open it directly.
      const editor = await vscode.window.showTextDocument(workingUri(model.root, f.path), { preview: true });
      const r = new vscode.Range(f.line, 0, f.endLine, 0);
      editor.selection = new vscode.Selection(r.start, r.start);
      editor.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  });

  reg('branchReview.copyFlagsMarkdown', async () => {
    const flags = tree.sortedFlags();
    if (flags.length === 0) {
      void vscode.window.showInformationMessage('Branch Review: no flags yet.');
      return;
    }
    await vscode.env.clipboard.writeText(flagsToMarkdown(flags, model.branch, model.baseRef));
    void vscode.window.showInformationMessage(`Branch Review: copied ${flags.length} flag(s) as Markdown.`);
  });

  reg('branchReview.clearFlags', async () => {
    const n = store.flags.length;
    if (n === 0) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(`Remove all ${n} flag(s)?`, { modal: true }, 'Remove');
    if (ok === 'Remove') {
      store.clearFlags();
    }
  });

  reg('branchReview.resetViewed', async () => {
    const ok = await vscode.window.showWarningMessage('Mark all files as unreviewed?', { modal: true }, 'Reset');
    if (ok === 'Reset') {
      store.resetViewed();
      await model.refresh();
    }
  });

  void model.refresh();
}

export function deactivate(): void {
  // state is flushed via disposables
}

function isNode(x: unknown): x is Node {
  return !!x && typeof x === 'object' && 'kind' in x;
}

function isLineArg(x: unknown): x is { lineNumber: number; uri: vscode.Uri } {
  return !!x && typeof x === 'object' && 'lineNumber' in x && 'uri' in x && (x as { uri: unknown }).uri instanceof vscode.Uri;
}

function flagsToMarkdown(flags: Flag[], branch: string, base: string): string {
  const out = [`## Review notes: \`${branch}\` vs \`${base}\``, ''];
  for (const f of flags) {
    const lines = f.endLine > f.line ? `L${f.line + 1}-L${f.endLine + 1}` : `L${f.line + 1}`;
    out.push(`- [ ] **\`${f.path}\` ${lines}**${f.side === 'base' ? ' (base)' : ''}${f.note ? ` — ${f.note}` : ''}`);
    if (f.snippet.trim()) {
      const fence = f.snippet.includes('```') ? '~~~' : '```';
      out.push(`  ${fence}`, ...f.snippet.split('\n').map((l) => `  ${l}`), `  ${fence}`);
    }
  }
  return out.join('\n') + '\n';
}
