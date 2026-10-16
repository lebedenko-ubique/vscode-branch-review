This project was created for my use-case of reviewing code: Open a branch (with potentially unstaged changes) and view a list of files that were modified compared to main. Be able to flag lines of code to come back later and be able to make edits in place.

Everything except the paragraph above is AI generated.

# Branch Review

Review **everything** on your current branch, including commits, staged changes, unstaged changes and untracked files, against a base branch or commit. You can flag suspicious lines to come back to later, and you can fix bugs in place.

## Sidebar (activity bar → Branch Review)

```
Base: main            merge-base a1b2c3d     ← click to pick another branch / tag / commit / any ref
▾ Flagged             2
    api.ts:42         is this null-safe?
    util.ts:10-14     duplicated logic
▾ Unreviewed          5
    M api.ts          src  +40 −3  ⚑1        [open file] [✓ mark viewed]
    A new.ts          src  +120 −0
    ...
▸ Viewed              3
```

- Files are compared against the **merge-base** of the base and `HEAD` (as in a PR). Set `branchReview.useMergeBase: false` to diff against the base tip instead.
- Click a file to open a diff of the base against the **working tree**. The right side is the real file, so anything you type there becomes a normal unstaged change.
- The list refreshes on its own when files change, when you commit, or when you switch branches. Each branch has its own review state.

## In the diff editor

| Action | How |
| --- | --- |
| Flag line(s) (with an optional note) | `⚑` button in the editor title, right-click → *Flag Line(s) for Review*, right-click the line number, or `Cmd+Alt+J` / `Ctrl+Alt+F` |
| Edit a flag's note | Flag the same line again, or use the pencil icon on the flag in the sidebar |
| Remove a flag | Right-click → *Remove Review Flag*, or the trash icon in the sidebar |
| Mark the file as viewed | `✓` button in the editor title |
| Mark as viewed and open the next unreviewed file | `✓✓` button, or `Cmd+Alt+V` / `Ctrl+Alt+V` |

Flags are highlighted in the editor and the overview ruler, and hovering one shows its note. They move with the code when you add or remove lines above them. You can flag lines on either side of the diff. A flag on the base side is useful for deleted code.

*Copy Flags as Markdown* (in the view's `…` menu, or the icon on the Flagged group) copies a checklist you can paste into a PR.

## Viewed files

A file stays in **Viewed** after you mark it. If it later changes outside your editor (for example after a `git pull` or an amend), it gets a *changed since viewed* marker. Edits you save yourself don't count. Set `branchReview.resetViewedOnChange: true` if such files should move back to Unreviewed instead.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `branchReview.defaultBase` | `main` | Falls back to `master`, `origin/main`, `origin/master`, `develop` |
| `branchReview.useMergeBase` | `true` | Diff against the merge-base (PR style) |
| `branchReview.includeUntracked` | `true` | Include new files that haven't been `git add`-ed |
| `branchReview.resetViewedOnChange` | `false` | See above |

## Development

```sh
npm install
npm run compile        # or: npm run watch
# Press F5 in VS Code to start an Extension Development Host
npm run package        # builds branch-review-0.1.0.vsix
code --install-extension branch-review-0.1.0.vsix
```
