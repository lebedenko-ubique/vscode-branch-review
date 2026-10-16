import * as vscode from 'vscode';
import { ReviewModel } from './review';
import { Flag, FlagSide } from './state';
import { parseBaseUri, relativeToRoot } from './uris';

export interface FlagTarget {
  path: string;
  side: FlagSide;
}

/** Which review file / side a document belongs to. */
export function targetFor(model: ReviewModel, uri: vscode.Uri): FlagTarget | undefined {
  const base = parseBaseUri(uri);
  if (base) {
    return { path: base.reviewPath, side: 'base' };
  }
  if (!model.root) {
    return undefined;
  }
  const rel = relativeToRoot(model.root, uri);
  return rel ? { path: rel, side: 'working' } : undefined;
}

export function flagsAt(model: ReviewModel, uri: vscode.Uri, line: number): Flag[] {
  const t = targetFor(model, uri);
  if (!t) {
    return [];
  }
  return model.store.flagsFor(t.path, t.side).filter((f) => line >= f.line && line <= f.endLine);
}

/** Renders flags as line decorations and keeps their positions in sync with edits. */
export class FlagDecorator implements vscode.Disposable {
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly model: ReviewModel, extensionUri: vscode.Uri) {
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('branchReview.flaggedLineBackground'),
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'flag.svg'),
      gutterIconSize: '80%',
      overviewRulerColor: new vscode.ThemeColor('charts.orange'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.disposables.push(
      this.decoration,
      vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
      vscode.workspace.onDidChangeTextDocument((e) => this.track(e)),
      model.store.onDidChange(() => this.render())
    );
  }

  render(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const t = targetFor(this.model, editor.document.uri);
      const flags = t ? this.model.store.flagsFor(t.path, t.side) : [];
      const lastLine = editor.document.lineCount - 1;
      editor.setDecorations(
        this.decoration,
        flags.map((f) => {
          const hover = new vscode.MarkdownString(undefined, true);
          hover.appendMarkdown('$(flag) **Flagged for review**');
          if (f.note) {
            hover.appendMarkdown('\n\n');
            hover.appendText(f.note);
          }
          return {
            range: new vscode.Range(Math.min(f.line, lastLine), 0, Math.min(f.endLine, lastLine), 0),
            hoverMessage: hover,
          };
        })
      );
    }
  }

  /** Shift flags when lines are inserted/removed above or inside them. */
  private track(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) {
      return;
    }
    const t = targetFor(this.model, e.document.uri);
    if (!t || t.side !== 'working') {
      return;
    }
    const flags = this.model.store.flagsFor(t.path, 'working');
    if (flags.length === 0) {
      return;
    }

    // All change ranges refer to the pre-edit document; apply bottom-up so they don't interfere.
    const changes = [...e.contentChanges].sort((a, b) => b.range.start.compareTo(a.range.start));
    let moved = false;
    for (const change of changes) {
      const start = change.range.start.line;
      const end = change.range.end.line;
      const inserted = countNewlines(change.text);
      const delta = inserted - (end - start);
      if (delta === 0 && start === end) {
        continue; // edit within a single line
      }
      // Inserting whole lines at column 0 pushes the line at `start` down too.
      const pushesStart = change.range.isEmpty && change.range.start.character === 0 && change.text.endsWith('\n');
      for (const f of flags) {
        const before = { line: f.line, endLine: f.endLine };
        f.line = pushesStart && f.line === start ? f.line + delta : this.shift(f.line, start, end, inserted, delta, f.snippet, e.document);
        f.endLine = pushesStart && f.endLine === start ? f.endLine + delta : shiftPlain(f.endLine, start, end, inserted, delta);
        f.endLine = Math.max(f.line, f.endLine);
        if (before.line !== f.line || before.endLine !== f.endLine) {
          moved = true;
        }
      }
    }
    if (moved) {
      this.model.store.flagsMoved();
    }
  }

  private shift(
    line: number,
    start: number,
    end: number,
    inserted: number,
    delta: number,
    snippet: string,
    doc: vscode.TextDocument
  ): number {
    if (line <= start) {
      return line;
    }
    if (line > end) {
      return line + delta;
    }
    // The flagged line was inside a replaced region: try to find its text again.
    const wanted = snippet.trim();
    const lo = start;
    const hi = Math.min(start + inserted, doc.lineCount - 1);
    if (wanted) {
      let best = -1;
      for (let l = lo; l <= hi; l++) {
        if (doc.lineAt(l).text.trim() === wanted && (best < 0 || Math.abs(l - line) < Math.abs(best - line))) {
          best = l;
        }
      }
      if (best >= 0) {
        return best;
      }
    }
    return Math.min(line, hi);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

function shiftPlain(line: number, start: number, end: number, inserted: number, delta: number): number {
  if (line <= start) {
    return line;
  }
  if (line > end) {
    return line + delta;
  }
  return Math.min(line, start + inserted);
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      n++;
    }
  }
  return n;
}
