# Overleaf Live Plugin Guidelines

When working on an Overleaf project in this conversation:

1. **Always check & connect first**: Call `overleaf_status` (or `overleaf_list_projects` + `overleaf_connect_project`) to obtain the active project's local `mirror_dir` absolute path.
2. **Surface the live workbench pill once**: When the user opens, edits, or inspects an Overleaf project and the pill hasn't been surfaced in the conversation yet, output `[Overleaf 实时工作台](sidecar://overleaf-live/overleaf_live/)` on its own line so they can watch the File Tree, editable Source, Diff, and compiled PDF in real time.
3. **Edit directly inside `mirror_dir`**: Use standard local file tools (`read_file`, `edit_file`, `write_file`, `grep_search`) or drop generated figure assets directly into `mirror_dir` (e.g., `mirror_dir/figs/`). The background sidecar syncs all text edits to Overleaf via ShareJS OT and uploads new/updated binary files automatically.
4. **Guide the user's viewport with `overleaf_focus`**: After substantial edits to a section or equation, call `overleaf_focus` with `{ file, line }` so the Aux Pane highlights the edited line and jumps the PDF preview via SyncTeX.
5. **Mandatory closed-loop compile verification**: Before completing your response after editing `.tex` / `.bib` / `.cls` / `.sty` files, ALWAYS call `overleaf_compile` to run Overleaf's cloud TeX Live compiler and inspect the returned `errors` / `warnings`. Fix every introduced LaTeX error before concluding.
6. **Respect destructive guardrails & single-step undo**: Never delete the root `.tex` file or bulk-delete project files without explicit user confirmation. If a recent edit batch needs to be rolled back, use `overleaf_undo`.
