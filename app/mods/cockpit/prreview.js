// A review in the making, on a pull request's page: a summary, a verdict, line comments and replies to threads, all editable
// before anything is sent. An agent writes the draft (the file below) or you start one; the preview shows what GitHub will
// get, and only "Post review" (after a confirmation) sends it, through bin/cockpit-pr-review.py. Nothing else writes to GitHub.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, TextareaState, Textarea, Input, TextView } from "gpui-base";
import { exec, notify, readTextFile, writeTextFile } from "herdr";
import * as hub from "./hub.js";
import { tokens, alpha, TEXT, RADIUS, Badge, Button, Tabs, Mono } from "./ui.js";

const keyOf = (p) => `${p.repo}#${p.number}`;
export const draftFile = (home, p) => `${home}/.cache/cockpit/review-drafts/${p.repo.replace("/", "__")}__${p.number}.json`;
const VERDICTS = [["COMMENT", "Comment"], ["APPROVE", "Approve"], ["REQUEST_CHANGES", "Request changes"]];

export class Drafts {
  constructor() {
    this.m = new Map();
    this.preview = new Set();
    this.confirm = null;
    this.busy = null;
    this.n = 0;
    // The pull request's files at its head (for the lines a comment is about): `repo#n:path` -> lines, or "loading".
    this.files = new Map();
  }

  /** Reads the draft file; true when what it shows changed (an agent wrote it, or the first read). */
  async load(cx, p) {
    const { home } = await hub.install();
    const text = await readTextFile(draftFile(home, p)).catch(() => null);
    const e = this.m.get(keyOf(p));
    if (e && e.raw === text) return false;
    if (text === null) {
      this.m.set(keyOf(p), { raw: null, exists: false });
      return !e || e.exists;
    }
    let d = {};
    try {
      d = JSON.parse(text);
    } catch {}
    const entry = { raw: text, exists: true, verdict: d.verdict ?? "COMMENT", chain: Promise.resolve(), p };
    const changed = () => this.queueSave(cx, entry);
    entry.summary = this.area(d.summary ?? "", "The review's summary: what you'd say when you submit it", 3, changed);
    entry.rows = (d.comments ?? []).map((c) => this.row(c, changed));
    for (const c of d.comments ?? []) if (c.path) this.ensureFile(cx, p, c.path);
    this.m.set(keyOf(p), entry);
    return true;
  }

  /** Reads a file of the pull request once, for the lines shown under a comment. */
  ensureFile(cx, p, path) {
    const key = `${keyOf(p)}:${path}`;
    if (!path || this.files.has(key)) return;
    this.files.set(key, "loading");
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-pr-file.py`, p.repo, String(p.number), path], { timeout: 90000 });
        this.files.set(key, JSON.parse(r.stdout || "{}").files?.[path] ?? null);
      } catch {
        this.files.set(key, null);
      }
      cx.notify();
    });
  }

  /** The lines a comment is on, with the line numbers, the commented one marked; nothing until the file is read. */
  snippet(k, p, path, line) {
    const lines = this.files.get(`${keyOf(p)}:${path}`);
    const n = Number(line);
    if (!Array.isArray(lines) || !n || n > lines.length) return null;
    const from = Math.max(1, n - 3), to = Math.min(lines.length, n + 3);
    const rows = [];
    for (let i = from; i <= to; i++)
      rows.push(h_flex().id(`sn-${path}-${i}`).gap(10).px(8).bg(i === n ? alpha(k.warning, 0.18) : alpha(k.muted, 0)).child(div().w(36).flex_none().text_right().text_size(10.5).font_family("JetBrains Mono").text_color(k.dim).child(String(i))).child(div().text_size(10.5).font_family("JetBrains Mono").whitespace_nowrap().text_color(i === n ? k.foreground : k.mutedFg).child(lines[i - 1] || " ")));
    return v_flex().w_full().py(4).rounded(RADIUS.sm).bg(alpha(k.muted, 0.7)).overflow_x_scrollbar().children(rows);
  }

  md(id, text) {
    return TextView.markdown(id, text).selectable(true).w_full();
  }

  area(value, placeholder, rows, onChange) {
    const s = TextareaState.new({ placeholder, value, rows });
    s.set_auto_grow(rows, 12);
    s.on("change", () => onChange());
    return s;
  }

  row(c, onChange) {
    const path = InputState.new({ placeholder: "path/to/file", value: c.path ?? "" });
    const line = InputState.new({ placeholder: "line", value: c.line ? String(c.line) : "" });
    path.on("change", () => onChange());
    line.on("change", () => onChange());
    return { id: `r${++this.n}`, reply_to: c.reply_to ?? null, quote: c.quote ?? null, path, line, body: this.area(c.body ?? "", c.reply_to ? "Your reply" : "Your comment on that line", 2, onChange) };
  }

  gather(e) {
    return {
      summary: e.summary.value(),
      verdict: e.verdict,
      comments: e.rows.map((r) => ({ ...(r.reply_to ? { reply_to: r.reply_to, quote: r.quote } : { path: r.path.value().trim(), line: Number(r.line.value()) || null }), body: r.body.value() })),
    };
  }

  /** Writes the draft after a typing pause; saves one at a time. */
  queueSave(cx, e) {
    e.version = (e.version ?? 0) + 1;
    const mine = e.version;
    cx.timer.after(500, () => {
      if (e.version !== mine) return;
      for (const r of e.rows) { const path = r.path.value().trim(); if (path && !r.reply_to) this.ensureFile(cx, e.p, path); }
      e.chain = e.chain.then(() => this.save(e)).catch(() => {});
    });
  }

  async save(e) {
    const { home } = await hub.install();
    const file = draftFile(home, e.p);
    const text = JSON.stringify(this.gather(e), null, 2) + "\n";
    const cur = await readTextFile(file).catch(() => null);
    if (cur === text) return (e.raw = text);
    if (cur === null) await exec("mkdir", ["-p", file.replace(/\/[^/]+$/, "")]);
    await writeTextFile(file, text, cur);
    e.raw = text;
  }

  async start(cx, p, first = null) {
    const { home } = await hub.install();
    const file = draftFile(home, p);
    if ((await readTextFile(file).catch(() => null)) === null) {
      await exec("mkdir", ["-p", file.replace(/\/[^/]+$/, "")]);
      await writeTextFile(file, JSON.stringify({ summary: "", verdict: "COMMENT", comments: first ? [first] : [] }, null, 2) + "\n", null);
    } else if (first) {
      const e = this.m.get(keyOf(p));
      if (e?.exists) {
        e.rows.push(this.row(first, () => this.queueSave(cx, e)));
        this.queueSave(cx, e);
        return cx.notify();
      }
    }
    this.m.delete(keyOf(p));
    await this.load(cx, p);
    cx.notify();
  }

  addComment(cx, p, c = {}) {
    const e = this.m.get(keyOf(p));
    if (!e?.exists) return this.start(cx, p, c);
    e.rows.push(this.row(c, () => this.queueSave(cx, e)));
    this.queueSave(cx, e);
    cx.notify();
  }

  async discard(cx, p) {
    const { home } = await hub.install();
    await exec("rm", ["-f", draftFile(home, p)]);
    this.m.set(keyOf(p), { raw: null, exists: false });
    this.preview.delete(keyOf(p));
    cx.notify();
  }

  /** Sends it (after the confirmation). */
  post(cx, p, done) {
    cx.spawn(async (cx) => {
      this.busy = keyOf(p);
      cx.notify();
      try {
        const e = this.m.get(keyOf(p));
        if (e?.exists) await this.save(e);
        const { home } = await hub.install();
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-pr-review.py`, p.repo, String(p.number), draftFile(home, p)], { timeout: 180000 });
        const d = JSON.parse(r.stdout || "{}");
        if (d.error) notify({ title: "Review not posted", body: d.error });
        else {
          notify({ title: "Review posted", body: `${keyOf(p)}: ${d.posted} comment${d.posted === 1 ? "" : "s"}, ${d.replies} repl${d.replies === 1 ? "y" : "ies"}` });
          this.m.set(keyOf(p), { raw: null, exists: false });
          this.preview.delete(keyOf(p));
          done?.(cx);
        }
      } catch (err) {
        notify({ title: "Review not posted", body: String(err?.message ?? err).slice(0, 160) });
      }
      this.busy = null;
      this.confirm = null;
      cx.notify();
    });
  }

  counts(e) {
    const rows = e.rows.filter((r) => r.body.value().trim());
    return { lines: rows.filter((r) => !r.reply_to).length, replies: rows.filter((r) => r.reply_to).length };
  }

  box(k, state) {
    return div().w_full().rounded(RADIUS.md).border_1().border_color(k.input).bg(k.background).px(10).py(6).child(Textarea.new(state).w_full().text_size(TEXT.sm));
  }

  /** The draft's page section: edit, or preview of what will be posted. `agentButton` starts an agent that writes the draft. */
  section(k, p, { agentButton } = {}) {
    const e = this.m.get(keyOf(p));
    const head = (extra = []) =>
      h_flex().gap(8).items_center().child(div().text_size(TEXT.base).font_semibold().child("Review draft")).child(div().flex_1()).children(extra.filter(Boolean));
    const frame = (...kids) => v_flex().gap(10).p(14).rounded(RADIUS.lg).border_1().border_color(alpha(k.info, 0.5)).bg(alpha(k.info, 0.05)).children(kids.filter(Boolean));
    if (!e?.exists)
      return frame(
        head(),
        div().text_size(TEXT.sm).text_color(k.mutedFg).whitespace_normal().child("Write a review here, or have an agent write one. You edit it, preview what GitHub will get, and nothing is sent until you post it."),
        h_flex().gap(8).child(Button("rv-start", { label: "Start a draft", icon: "file-text", size: "sm", variant: "outline", onClick: (_e, cx) => this.start(cx, p) })).children([agentButton].filter(Boolean)),
      );
    const showPreview = this.preview.has(keyOf(p));
    const { lines, replies } = this.counts(e);
    const tone = e.verdict === "APPROVE" ? k.success : e.verdict === "REQUEST_CHANGES" ? k.destructive : k.mutedFg;
    const verdictTabs = Tabs("rv-verdict", { value: e.verdict, onChange: (v, cx) => ((e.verdict = v), this.queueSave(cx, e), cx.notify()), items: VERDICTS.map(([value, label]) => ({ value, label })) });
    const actions = h_flex().gap(8).items_center().children([
      Button("rv-preview", { label: showPreview ? "Back to editing" : "Preview", icon: showPreview ? "pencil" : "eye", size: "sm", variant: "outline", onClick: (_e, cx) => { showPreview ? this.preview.delete(keyOf(p)) : this.preview.add(keyOf(p)); cx.notify(); } }),
      Button("rv-post", { label: this.busy === keyOf(p) ? "Posting…" : "Post review…", size: "sm", disabled: this.busy === keyOf(p) || (!lines && !replies && !e.summary.value().trim() && e.verdict === "COMMENT"), onClick: (_e, cx) => ((this.confirm = { p }), cx.notify()) }),
      Button("rv-discard", { label: "Discard", size: "sm", variant: "ghost", onClick: (_e, cx) => this.discard(cx, p) }),
    ]);
    if (showPreview) {
      const verb = e.verdict === "APPROVE" ? "approved these changes" : e.verdict === "REQUEST_CHANGES" ? "requested changes" : "reviewed";
      const summary = e.summary.value().trim();
      return frame(
        head([Badge("preview", "secondary"), actions]),
        div().text_size(TEXT.xs).text_color(k.dim).child("This is what GitHub will get. Nothing is sent until you post it."),
        v_flex().gap(8).p(12).rounded(RADIUS.md).border_1().border_color(k.border).bg(k.card)
          .child(h_flex().gap(8).items_center().child(div().text_size(TEXT.sm).font_semibold().child("You")).child(div().text_size(TEXT.sm).text_color(tone).child(verb)))
          .child(summary ? this.md(`rv-md-sum-${keyOf(p)}`, summary) : div().text_size(TEXT.sm).text_color(k.dim).child("No summary.")),
        ...e.rows.filter((r) => r.body.value().trim()).map((r) =>
          v_flex().id(`rv-pv-${r.id}`).gap(6).p(10).rounded(RADIUS.md).border_1().border_color(k.border)
            .child(r.reply_to ? h_flex().gap(6).child(Badge("reply", "secondary")).child(div().text_size(TEXT.xs).text_color(k.dim).truncate().child(r.quote ?? "in the thread")) : Mono(`${r.path.value()}${r.line.value() ? `:${r.line.value()}` : ""}`, { size: TEXT.xs, color: k.foreground }))
            .children([!r.reply_to ? this.snippet(k, p, r.path.value().trim(), r.line.value()) : null].filter(Boolean))
            .child(this.md(`rv-md-${r.id}`, r.body.value())),
        ),
        div().text_size(TEXT.xs).text_color(k.dim).child(`${lines} line comment${lines === 1 ? "" : "s"} and ${replies} repl${replies === 1 ? "y" : "ies"}; empty ones are left out.`),
      );
    }
    return frame(
      head([actions]),
      verdictTabs,
      this.box(k, e.summary),
      ...e.rows.map((r) =>
        v_flex().id(`rv-row-${r.id}`).gap(6).p(10).rounded(RADIUS.md).border_1().border_color(k.border).bg(k.card)
          .child(
            h_flex().gap(6).items_center()
              .children(
                r.reply_to
                  ? [Badge("reply", "secondary"), div().flex_1().min_w(0).truncate().text_size(TEXT.xs).text_color(k.dim).child(r.quote ?? "to a thread")]
                  : [div().w(300).h(26).px(8).flex().items_center().rounded(RADIUS.sm).border_1().border_color(k.input).bg(k.background).child(Input.new(r.path).flex_1().h_full().text_size(TEXT.xs).text_color(k.foreground)), div().text_color(k.dim).child(":"), div().w(64).h(26).px(8).flex().items_center().rounded(RADIUS.sm).border_1().border_color(k.input).bg(k.background).child(Input.new(r.line).flex_1().h_full().text_size(TEXT.xs).text_color(k.foreground)), div().flex_1()],
              )
              .child(Button(`rv-rm-${r.id}`, { label: "Remove", size: "sm", variant: "ghost", onClick: (_e, cx) => { e.rows = e.rows.filter((x) => x !== r); this.queueSave(cx, e); cx.notify(); } })),
          )
          .children([!r.reply_to ? this.snippet(k, p, r.path.value().trim(), r.line.value()) : null].filter(Boolean))
          .child(this.box(k, r.body)),
      ),
      h_flex().gap(8).child(Button("rv-add", { label: "Add a line comment", icon: "plus", size: "sm", variant: "outline", onClick: (_e, cx) => this.addComment(cx, p) })).children([agentButton].filter(Boolean)),
    );
  }
}
