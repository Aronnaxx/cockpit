// "Files changed" for a pull request, as GitHub has it: the files, each as a diff (hunks in the file's language, old and new line
// numbers) or as the whole file with the changed lines tinted. A click on a new line's number starts a comment on that line in
// the review draft; the draft's comments for the file sit under it, editable. Nothing is posted from here.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, notify } from "herdr";
import * as hub from "./hub.js";
import { tokens, alpha, TEXT, RADIUS, Badge, Button, Empty, Mono, Spinner, Tabs } from "./ui.js";
import { CodeBlock, DiffBlock, makeCode, LINE } from "./codeblock.js";
import { openFileAt, githubFileUrl } from "./editors.js";
import { repoFolder } from "./agentlaunch.js";

const keyOf = (p) => `${p.repo}#${p.number}`;

/** A patch's text as hunks: [{header, rows: [{t, old, new, text}]}]. */
export function parsePatch(patch) {
  const hunks = [];
  let cur = null, o = 0, n = 0;
  for (const line of String(patch ?? "").split("\n")) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (m) {
      o = Number(m[1]);
      n = Number(m[2]);
      cur = { header: `@@ -${m[1]} +${m[2]} @@${m[3]}`, rows: [] };
      hunks.push(cur);
    } else if (cur && !line.startsWith("\\")) {
      const t = line[0] === "+" || line[0] === "-" ? line[0] : " ";
      cur.rows.push({ t, old: t === "+" ? null : o, new: t === "-" ? null : n, text: line.slice(1) });
      if (t !== "+") o++;
      if (t !== "-") n++;
    }
  }
  return hunks;
}

export class PrFiles {
  constructor() {
    this.data = new Map(); // key -> {files, error} | "loading"
    this.sel = new Map(); // key -> path
    this.mode = "diff";
    this.trees = new Map(); // key -> worktree path
    this.built = new Map(); // key:path -> [{hunk, code}]
    this.full = new Map(); // key:path -> {code, lines} | "loading" | null
  }

  files(p) {
    const d = this.data.get(keyOf(p));
    return d && d !== "loading" ? d.files : null;
  }

  load(cx, p, force = false) {
    if (!force && this.data.has(keyOf(p))) return;
    this.data.set(keyOf(p), "loading");
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-pr-diff.py`, p.repo, String(p.number)], { timeout: 120000 });
        const d = JSON.parse(r.stdout || "{}");
        for (const f of d.files ?? []) {
          const hunks = parsePatch(f.patch);
          this.built.set(`${keyOf(p)}:${f.path}`, hunks.map((h) => ({ hunk: h, code: makeCode(h.rows.map((x) => x.text), f.path) })));
        }
        this.data.set(keyOf(p), d);
        if (!this.sel.get(keyOf(p)) && d.files?.length) this.sel.set(keyOf(p), d.files[0].path);
      } catch (e) {
        this.data.set(keyOf(p), { files: [], error: String(e?.message ?? e).slice(0, 160) });
      }
      cx.notify();
    });
  }

  /** The whole file at the PR's head, read when "Full file" is picked. */
  loadFull(cx, p, path) {
    const key = `${keyOf(p)}:${path}`;
    if (this.full.has(key)) return;
    this.full.set(key, "loading");
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-pr-file.py`, p.repo, String(p.number), path], { timeout: 90000 });
        const lines = JSON.parse(r.stdout || "{}").files?.[path];
        this.full.set(key, lines ? { code: makeCode(lines, path), lines: lines.length } : null);
      } catch {
        this.full.set(key, null);
      }
      cx.notify();
    });
  }

  /** The PR's worktree (made on first use), where the editor opens a file. */
  async tree(p, cfg) {
    const hit = this.trees.get(keyOf(p));
    if (hit) return hit;
    const { home } = await hub.install();
    const folder = repoFolder(p.repo, cfg).replace(/^~/, home);
    const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-worktree.py`, p.repo, String(p.number), folder, "--branch", p.branch], { timeout: 400000 });
    const d = JSON.parse(r.stdout || "{}");
    if (d.error) throw new Error(d.error);
    this.trees.set(keyOf(p), d.path);
    return d.path;
  }

  /** The file (at a line) in VS Code, in the PR's worktree. */
  inEditor(cx, p, cfg, path, line = 1, id = "vscode") {
    cx.spawn(async () => {
      try {
        await openFileAt(id, await this.tree(p, cfg), path, line);
      } catch (e) {
        notify({ title: "Could not open it", body: String(e?.message ?? e).slice(0, 160) });
      }
    });
  }

  onGithub(cx, p, path, line = null) {
    cx.spawn(async () => hub.openUrl(await githubFileUrl(p, path, line)));
  }

  pick(cx, p, path) {
    this.sel.set(keyOf(p), path);
    if (this.mode === "full") this.loadFull(cx, p, path);
    cx.notify();
  }

  setMode(cx, p, mode) {
    this.mode = mode;
    const path = this.sel.get(keyOf(p));
    if (mode === "full" && path) this.loadFull(cx, p, path);
    cx.notify();
  }

  /** The page. `drafts` is the review draft (comments added here go into it). */
  render(k, p, drafts, cfg = {}) {
    const d = this.data.get(keyOf(p));
    if (!d || d === "loading") return h_flex().h(160).justify_center().items_center().gap(8).text_color(k.mutedFg).child(Spinner({ size: 14 })).child("Reading the changed files…");
    if (d.error) return Empty({ icon: "git-commit", title: "Could not read the files", description: d.error });
    const files = d.files ?? [];
    const path = this.sel.get(keyOf(p)) ?? files[0]?.path;
    const file = files.find((f) => f.path === path);
    const pending = (pth) => (drafts.m.get(keyOf(p))?.rows ?? []).filter((r) => !r.reply_to && r.path.value().trim() === pth);
    const addAt = (pth) => (line, cx) => {
      drafts.addComment(cx, p, { path: pth, line });
      notify({ title: "Comment started", body: `${pth}:${line} · it is in your review draft` });
    };
    const list = v_flex()
      .id("pf-list")
      .w(320)
      .flex_none()
      .min_h(0)
      .overflow_y_scrollbar()
      .gap(2)
      .children(
        files.map((f) => {
          const on = f.path === path;
          const n = pending(f.path).length;
          const slash = f.path.lastIndexOf("/");
          return v_flex()
            .id(`pf-${f.path}`)
            .gap(1)
            .px(10)
            .py(6)
            .rounded(RADIUS.md)
            .cursor_pointer()
            .when(on, (e) => e.bg(k.selected))
            .when(!on, (e) => e.hover((x) => x.bg(k.accent)))
            .on_click((_e, cx) => this.pick(cx, p, f.path))
            .child(div().text_size(TEXT.sm).font_medium().truncate().child(f.path.slice(slash + 1)))
            .child(
              h_flex()
                .gap(8)
                .text_size(TEXT.xs)
                .text_color(k.dim)
                .child(div().flex_1().min_w(0).truncate().child(slash > 0 ? f.path.slice(0, slash) : ""))
                .when(n > 0, (e) => e.child(div().text_color(k.warning).child(`${n} ●`)))
                .child(div().text_color(k.success).child(`+${f.additions}`))
                .child(div().text_color(k.destructive).child(`−${f.deletions}`)),
            );
        }),
      );
    let body;
    if (!file) body = Empty({ icon: "git-commit", title: "No files", description: "This pull request changes none." });
    else if (this.mode === "full") {
      const fl = this.full.get(`${keyOf(p)}:${file.path}`);
      if (!fl || fl === "loading") body = h_flex().h(120).justify_center().items_center().gap(8).text_color(k.mutedFg).child(Spinner({ size: 14 })).child("Reading the file…");
      else {
        const changed = new Set();
        for (const h of parsePatch(file.patch)) for (const r of h.rows) if (r.t === "+") changed.add(r.new);
        const rows = Array.from({ length: fl.lines }, (_, i) => ({ t: changed.has(i + 1) ? "+" : " ", old: null, new: i + 1 }));
        body = DiffBlock(`pf-full-${file.path}`, fl.code, rows, { onLine: addAt(file.path), marked: new Set(pending(file.path).map((r) => Number(r.line.value()))) });
      }
    } else {
      const built = this.built.get(`${keyOf(p)}:${file.path}`) ?? [];
      body = built.length
        ? v_flex().gap(8).children(built.flatMap(({ hunk, code }, i) => [div().id(`pf-h-${i}`).px(8).py(3).rounded(RADIUS.sm).bg(alpha(k.info, 0.1)).text_size(TEXT.xs).font_family("JetBrains Mono").text_color(k.info).child(hunk.header), DiffBlock(`pf-d-${file.path}-${i}`, code, hunk.rows, { onLine: addAt(file.path), marked: new Set(pending(file.path).map((r) => Number(r.line.value()))) })]))
        : div().text_size(TEXT.sm).text_color(k.dim).child(`${file.status === "renamed" ? "Renamed" : "No text diff"} (a binary file, or one too large to show here). Use “Full file”.`);
    }
    const mine = file ? pending(file.path) : [];
    return h_flex()
      .gap(16)
      .items_start()
      .child(list)
      .child(
        v_flex()
          .id("pf-view")
          .flex_1()
          .min_w(0)
          .gap(10)
          .child(
            h_flex()
              .gap(10)
              .items_center()
              .child(Mono(file?.path ?? "", { size: TEXT.sm, color: k.foreground }))
              .child(div().flex_1())
              .children(file ? [Button("pf-vscode", { label: "VS Code", icon: "code", size: "sm", variant: "outline", tooltip: "This file in VS Code, in the PR's worktree", onClick: (_e, cx) => this.inEditor(cx, p, cfg, file.path, 1) }), Button("pf-github", { label: "GitHub", icon: "external", size: "sm", variant: "outline", tooltip: "This file in the PR's Files changed on GitHub", onClick: (_e, cx) => this.onGithub(cx, p, file.path) })] : [])
              .child(Tabs("pf-mode", { value: this.mode, onChange: (v, cx) => this.setMode(cx, p, v), items: [{ value: "diff", label: "Diff" }, { value: "full", label: "Full file" }] })),
          )
          .child(div().text_size(TEXT.xs).text_color(k.dim).child("Click a line's number to comment on it. Comments go into your review draft; nothing is posted until you post it."))
          .child(body)
          .children(mine.length ? [div().text_size(TEXT.sm).font_semibold().child(`Your comments on this file · ${mine.length}`), ...mine.map((r) => v_flex().id(`pf-c-${r.id}`).gap(6).p(10).rounded(RADIUS.md).border_1().border_color(alpha(k.warning, 0.5)).bg(k.card).child(h_flex().gap(8).items_center().child(Mono(`line ${r.line.value() || "?"}`, { size: TEXT.xs, color: k.foreground })).child(div().flex_1()).child(Button(`pf-vs-${r.id}`, { label: "VS Code", size: "sm", variant: "ghost", onClick: (_e, cx) => this.inEditor(cx, p, cfg, file.path, Number(r.line.value()) || 1) })).child(Button(`pf-gh-${r.id}`, { label: "GitHub", size: "sm", variant: "ghost", onClick: (_e, cx) => this.onGithub(cx, p, file.path, Number(r.line.value()) || null) })).child(Button(`pf-rm-${r.id}`, { label: "Remove", size: "sm", variant: "ghost", onClick: (_e, cx) => drafts.removeRow(cx, p, r) }))).child(drafts.box(k, r.body)))] : []),
      );
  }
}
