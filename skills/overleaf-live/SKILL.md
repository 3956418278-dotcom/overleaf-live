---
name: overleaf-live
description: >-
  Read, edit, sync, and cloud-compile Overleaf (overleaf.com) LaTeX projects in
  real time via a local mirror directory and the native Antigravity Auxiliary Pane
  workbench (file tree, editable source, live diff, PDF preview, and SyncTeX).
  Activate when the user asks to edit, review, compile, debug, or preview an
  Overleaf paper or LaTeX project.
---

# Overleaf Live Collaboration Workflow

This skill connects the Antigravity agent directly to the user's Overleaf account
and native Auxiliary Pane workbench without needing an external browser tab.

## Quick Workflow

1. **Check Session & Active Project**
   - Call `overleaf_status`.
   - If `authenticated: false`, guide the user to open `[Overleaf 实时工作台](sidecar://overleaf-live/overleaf_live/)` and click **登录 / 设置** to either:
     - Click **弹窗登录 Overleaf** (supports Google OAuth / Institutional SSO / CAPTCHA in an isolated browser popup), or
     - Paste their `overleaf_session2` / `Cookie` header / Cookie-Editor JSON once.
   - Never attempt to automate or bypass Overleaf login forms or CAPTCHAs.

2. **Connect a Project to This Conversation**
   - Call `overleaf_list_projects` if the project ID is unknown, then call `overleaf_connect_project({ project_id, mirror_dir? })`.
   - If the user did not specify a custom folder (such as `<workspace>/paper`), omit `mirror_dir` so it defaults cleanly to `~/.gemini/antigravity/scratch/overleaf/<project-slug>-<id6>/`.
   - Emit `[Overleaf 实时工作台](sidecar://overleaf-live/overleaf_live/)` once in chat so the user can open the live File Tree + Source + PDF workbench in the side pane.

3. **Edit & Add Figures Locally with Live OT Sync**
   - Read and modify `.tex`, `.bib`, `.cls`, `.sty` files inside the returned `mirror_dir` using `read_file`, `edit_file`, `write_file`, and `grep_search`.
   - Never convert line endings to `\r\n` unnecessarily; the sync engine normalizes `\n` and pushes incremental ShareJS `text0` OT updates automatically.
   - To add a new file/folder explicitly or upload a binary figure, either save the file inside `mirror_dir` or call `overleaf_file_ops`.

4. **Track & Highlight Edits (`overleaf_focus`)**
   - After editing a section, call `overleaf_focus({ file: "sections/method.tex", line: 84 })` to highlight that line in the user's Aux Pane and trigger Forward SyncTeX jump on the compiled PDF.

5. **Closed-Loop Cloud Compilation (`overleaf_compile`)**
   - After finishing edits, ALWAYS run `overleaf_compile` (with `draft: false` for final verification).
   - Inspect `errors` and `warnings` returned from Overleaf's `output.log`. If any LaTeX error exists, fix the affected `.tex`/`.bib` file in `mirror_dir` and re-run `overleaf_compile` until `errorCount === 0`.

6. **Single-Step Undo & Guardrails**
   - The sidecar preserves a single-step pre-edit snapshot for the latest edit batch (`overleaf_undo`).
   - Deleting the project root `.tex` file or deleting multiple files at once via filesystem watcher is blocked automatically; explicit intentional deletions require `overleaf_file_ops` with `action: "delete"` and `confirm_delete: true`.
