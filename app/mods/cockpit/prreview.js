// A review in the making, on a pull request's page: a summary, a verdict, line comments and replies to threads, all editable
// before anything is sent. An agent writes the draft (the file below) or you start one; the preview shows what GitHub will
// get, and only "Post review" (after a confirmation) sends it, through bin/cockpit-pr-review.py. Nothing else writes to GitHub.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, TextareaState, Textarea, Input, TextView } from "gpui-base";
import { exec, notify, readTextFile, writeTextFile } from "herdr";
import * as hub from "./hub.js";
import { tokens, alpha, TEXT, RADIUS, Badge, Button, Tabs, Mono, Spinner, Toggle } from "./ui.js";
import { CodeRows } from "./codeblock.js";

const keyOf = (p) => `${p.repo}#${p.number}`;
export const draftFile = (home, p) => `${home}/.cache/cockpit/review-drafts/${p.repo.replace("/", "__")}__${p.number}.json`;
/** A line field's text as a range: "12" or "12-18" (also "12:18"): {start, end}; null when it is not a line. */
export function parseRange(text) {
  const m = String(text ?? "").trim().match(/^(\d+)(?:\s*[-–:]\s*(\d+))?$/);
  if (!m) return null;
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

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
    // "Why?" under a comment: the rows whose reason is shown, and the explanations being written.
    this.whyOpen = new Set();
    this.whyBusy = new Set();
    // The gateway model that explains (set by the page).
    this.modelOf = () => "";
    // Kept in sync with your pending review on GitHub (bin/cockpit-pr-pending.py): key -> {on, busy, at, error, conflict, exists}.
    this.sync = new Map();
  }

  /** The pending-review helper: status, push (the draft to GitHub), pull (GitHub's to the draft) or off. */
  pending(cx, p, op, { force = false } = {}) {
    const key = keyOf(p);
    const st = { ...(this.sync.get(key) ?? {}) };
    st.busy = op;
    this.sync.set(key, st);
    cx.notify();
    return new Promise((resolve) =>
      cx.spawn(async (cx) => {
        let d = {};
        try {
          const { home } = await hub.install();
          const e = this.m.get(key);
          if (e?.exists && op === "push") await this.save(e);
          const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-pr-pending.py`, p.repo, String(p.number), draftFile(home, p), op, ...(force ? ["--force"] : [])], { timeout: 180000 });
          d = JSON.parse(r.stdout || "{}");
        } catch (err) {
          d = { error: String(err?.message ?? err).slice(0, 200) };
        }
        const next = { ...(this.sync.get(key) ?? {}), busy: null, error: d.error ?? null };
        if (op === "status") Object.assign(next, { on: Boolean(d.sync), exists: d.exists, conflict: d.sync && d.changed ? { summary: d.summary, comments: d.comments ?? [] } : null, at: d.synced_at ?? next.at });
        if (op === "push") Object.assign(next, d.conflict ? { on: true, conflict: { summary: d.summary, comments: d.comments ?? [] } } : d.error ? {} : { on: true, conflict: null, exists: (d.synced ?? 0) > 0, at: Date.now(), replies: d.replies_kept ?? 0 });
        if (op === "pull" && !d.error) {
          Object.assign(next, { on: true, conflict: null, exists: true, at: Date.now() });
          this.m.delete(key);
          await this.load(cx, p);
        }
        if (op === "off") Object.assign(next, { on: false, conflict: null });
        this.sync.set(key, next);
        cx.notify();
        resolve(d);
      }),
    );
  }

  /** A push a few seconds after the last save, while syncing is on. */
  schedulePush(cx, p) {
    const key = keyOf(p);
    const st = this.sync.get(key);
    if (!st?.on || st.conflict) return;
    st.version = (st.version ?? 0) + 1;
    const mine = st.version;
    cx.timer.after(4000, (cx) => {
      const now = this.sync.get(key);
      if (now?.version === mine && now.on && !now.busy && !now.conflict) this.pending(cx, p, "push");
    });
  }

  /** Reads the draft file; true when what it shows changed (an agent wrote it, or the first read). */
  async load(cx, p) {
    const { home } = await hub.install();
    const text = await readTextFile(draftFile(home, p)).catch(() => null);
    const e = this.m.get(keyOf(p));
    if (e && e.raw === text) return false;
    // While you type (or just did), what is on disk is your own save: leave the boxes alone.
    if (e?.exists && Date.now() - (e.touched ?? 0) < 6000) return false;
    if (text === null) {
      if (e && !e.exists) return false;
      // No draft yet: the box is there to type in; the first keystroke makes the draft.
      const blank = { raw: null, exists: false, verdict: "COMMENT", chain: Promise.resolve(), p, rows: [] };
      blank.summary = this.area("", "Leave a review comment", 3, () => this.begin(cx, blank));
      this.m.set(keyOf(p), blank);
      return true;
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

  /** The first keystroke (or a verdict, or a line comment) in a blank box: it becomes a draft, kept on disk. */
  begin(cx, e) {
    if (e.exists) return this.queueSave(cx, e);
    e.exists = true;
    e.summary.on("change", () => this.queueSave(cx, e));
    this.queueSave(cx, e);
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

  /** The lines a comment is on (three around it), with the line numbers and the commented one tinted; nothing until the file is read. */
  snippet(k, p, path, line) {
    const lines = this.files.get(`${keyOf(p)}:${path}`);
    const r = parseRange(line);
    if (!Array.isArray(lines) || !r || r.end > lines.length) return null;
    const from = Math.max(1, r.start - 3), to = Math.min(lines.length, r.end + 3);
    const rows = [];
    for (let i = from; i <= to; i++) rows.push({ num: i, text: lines[i - 1], mark: i >= r.start && i <= r.end ? k.warning : null });
    return CodeRows(`sn-${path}-${r.start}-${r.end}`, rows, path);
  }

  /** Why a comment was made: the agent's own note, then (asked for) an explanation from the code, the diff and the agent's session. */
  explainWhy(cx, p, r) {
    const model = this.modelOf();
    if (!model) return notify({ title: "Pick a model first", body: "Pick the explaining model under Explain (the PR page's Explain button)." });
    const e = this.m.get(keyOf(p));
    if (!e) return;
    this.whyBusy.add(r.id);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.save(e);
        const { home } = await hub.install();
        const res = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-explain.py`, "why", p.repo, String(p.number), String(e.rows.indexOf(r)), model], { timeout: 300000 });
        const d = JSON.parse(res.stdout || "{}");
        if (d.error) notify({ title: "No explanation", body: d.error });
        else {
          r.explained = { text: d.text, model: d.model, sources: d.sources ?? [] };
          this.queueSave(cx, e);
        }
      } catch (err) {
        notify({ title: "No explanation", body: String(err?.message ?? err).slice(0, 160) });
      }
      this.whyBusy.delete(r.id);
      cx.notify();
    });
  }

  whyButton(r) {
    const on = this.whyOpen.has(r.id);
    return Button(`rv-why-${r.id}`, { label: "Why?", icon: "circle-help", size: "sm", variant: on ? "secondary" : "ghost", tooltip: "Why this comment was made", onClick: (_e, cx) => { on ? this.whyOpen.delete(r.id) : this.whyOpen.add(r.id); cx.notify(); } });
  }

  whyPanel(k, p, r) {
    if (!this.whyOpen.has(r.id)) return null;
    const busy = this.whyBusy.has(r.id);
    return v_flex().id(`rv-whyp-${r.id}`).gap(8).p(10).rounded(RADIUS.md).border_l_2().border_color(k.info).bg(alpha(k.info, 0.06))
      .child(div().text_size(TEXT.xs).font_semibold().text_color(k.info).child("Why it was made"))
      .child(r.why ? v_flex().gap(2).child(div().text_size(TEXT.xs).text_color(k.dim).child("The agent's own note")).child(this.md(`rv-why-own-${r.id}`, r.why)) : div().text_size(TEXT.xs).text_color(k.dim).child("The agent left no note of its reason with this comment."))
      .children(r.explained ? [div().text_size(TEXT.xs).text_color(k.dim).child(`Explained by ${r.explained.model}${r.explained.sources?.length ? ` from ${r.explained.sources.join(", ")}` : " (no session of the agent found)"}`), this.md(`rv-why-x-${r.id}`, r.explained.text)] : [])
      .child(h_flex().gap(8).items_center()
        .child(Button(`rv-why-go-${r.id}`, { label: busy ? "Explaining…" : r.explained ? "Explain again" : `Explain with ${this.modelOf() || "a model"}`, icon: "sparkles", size: "sm", variant: "outline", disabled: busy, tooltip: "Reads the code, the PR's diff of the file and the reviewing agent's session", onClick: (_e, cx) => this.explainWhy(cx, p, r) }))
        .when(busy, (x) => x.child(Spinner({ size: 12 }))));
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
    const line = InputState.new({ placeholder: "line", value: c.line ? (c.start_line && c.start_line < c.line ? `${c.start_line}-${c.line}` : String(c.line)) : "" });
    path.on("change", () => onChange());
    line.on("change", () => onChange());
    return { id: `r${++this.n}`, reply_to: c.reply_to ?? null, quote: c.quote ?? null, why: c.why ?? null, explained: c.explained ?? null, path, line, body: this.area(c.body ?? "", c.reply_to ? "Your reply" : "Your comment on that line", 2, onChange) };
  }

  gather(e) {
    return {
      summary: e.summary.value(),
      verdict: e.verdict,
      comments: e.rows.map((r) => ({ ...(r.reply_to ? { reply_to: r.reply_to, quote: r.quote } : { path: r.path.value().trim(), ...(parseRange(r.line.value()) ? { line: parseRange(r.line.value()).end, ...(parseRange(r.line.value()).start < parseRange(r.line.value()).end ? { start_line: parseRange(r.line.value()).start } : {}) } : { line: null }) }), body: r.body.value(), ...(r.why ? { why: r.why } : {}), ...(r.explained ? { explained: r.explained } : {}) })),
    };
  }

  /** Writes the draft after a typing pause; saves one at a time. */
  queueSave(cx, e) {
    e.touched = Date.now();
    e.version = (e.version ?? 0) + 1;
    const mine = e.version;
    cx.timer.after(500, () => {
      if (e.version !== mine) return;
      for (const r of e.rows) { const path = r.path.value().trim(); if (path && !r.reply_to) this.ensureFile(cx, e.p, path); }
      e.chain = e.chain.then(() => this.save(e)).then(() => this.schedulePush(cx, e.p)).catch(() => {});
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
    if (!e) return this.start(cx, p, c);
    if (!e.exists) this.begin(cx, e);
    e.rows.push(this.row(c, () => this.queueSave(cx, e)));
    this.queueSave(cx, e);
    cx.notify();
  }

  removeRow(cx, p, r) {
    const e = this.m.get(keyOf(p));
    if (!e) return;
    e.rows = e.rows.filter((x) => x !== r);
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
  post(cx, p, done, pending = false) {
    cx.spawn(async (cx) => {
      this.busy = keyOf(p);
      cx.notify();
      try {
        const e = this.m.get(keyOf(p));
        if (e?.exists) await this.save(e);
        const { home } = await hub.install();
        // Synced: the pending review on GitHub is brought up to date and submitted, rather than a second review made.
        const synced = this.sync.get(keyOf(p))?.on;
        if (synced) {
          const pushed = await this.pending(cx, p, "push");
          if (pushed.conflict || pushed.error) {
            notify({ title: "Review not posted", body: pushed.conflict ? "Your pending review on GitHub changed outside the cockpit: pick which to keep first." : pushed.error });
            this.busy = null;
            this.confirm = null;
            return cx.notify();
          }
        }
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-pr-review.py`, p.repo, String(p.number), draftFile(home, p), ...(pending ? ["--pending"] : []), ...(synced ? ["--submit-pending"] : [])], { timeout: 180000 });
        const d = JSON.parse(r.stdout || "{}");
        if (d.error) notify({ title: pending ? "Not kept on GitHub" : "Review not posted", body: d.error });
        else if (d.pending !== undefined) notify({ title: "Kept as a pending review on GitHub", body: `${keyOf(p)}: ${d.pending} comment${d.pending === 1 ? "" : "s"}. Only you see it; open it in VS Code's pull request view and submit it there, or keep editing here.` });
        else {
          notify({ title: "Review posted", body: `${keyOf(p)}: ${d.posted} comment${d.posted === 1 ? "" : "s"}, ${d.replies} repl${d.replies === 1 ? "y" : "ies"}` });
          this.m.set(keyOf(p), { raw: null, exists: false });
          this.preview.delete(keyOf(p));
          this.sync.delete(keyOf(p));
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

  /** Keeping the draft in sync with your pending review on GitHub: the switch, where it stands, and the choice when GitHub's
   *  side was edited meanwhile (VS Code's pull request view, the PR page). */
  syncRow(k, p, e) {
    const st = this.sync.get(keyOf(p)) ?? {};
    const on = Boolean(st.on);
    const status = st.busy === "push" ? "Sending to GitHub…" : st.busy === "pull" ? "Taking GitHub's…" : st.busy === "status" && !st.at ? "Checking GitHub…" : st.error ? st.error : on ? (st.at ? `In sync · ${Math.max(0, Math.round((Date.now() - st.at) / 60000))}m ago${st.replies ? ` · ${st.replies} repl${st.replies === 1 ? "y stays" : "ies stay"} here (a reply cannot be pending)` : ""}` : "On") : st.exists ? "You have a pending review on GitHub that is not kept in sync" : "Only you see a pending review; VS Code's pull request view lists and edits it";
    const box = st.conflict
      ? v_flex().gap(8).p(10).rounded(RADIUS.md).border_1().border_color(alpha(k.warning, 0.6)).bg(alpha(k.warning, 0.08))
          .child(div().text_size(TEXT.sm).font_semibold().text_color(k.warning).child("Your pending review on GitHub was changed outside the cockpit"))
          .child(div().text_size(TEXT.xs).text_color(k.mutedFg).whitespace_normal().child(`GitHub's has ${st.conflict.comments.length} comment${st.conflict.comments.length === 1 ? "" : "s"}${st.conflict.summary ? " and a summary" : ""}; this draft has ${(e?.rows ?? []).filter((r) => !r.reply_to && r.body.value().trim()).length}. Nothing is sent until you pick.`))
          .children(st.conflict.comments.slice(0, 4).map((c, i) => div().id(`rv-cf-${i}`).text_size(TEXT.xs).text_color(k.dim).truncate().child(`${String(c.path).split("/").pop()}:${c.start_line ? `${c.start_line}-` : ""}${c.line} · ${c.body}`)))
          .child(h_flex().gap(8).child(Button("rv-sync-pull", { label: "Use GitHub's", icon: "git-pull-request", size: "sm", variant: "outline", tooltip: "GitHub's summary and line comments replace the draft's (replies and reasons are kept)", onClick: (_e, cx) => this.pending(cx, p, "pull") })).child(Button("rv-sync-force", { label: "Use mine", size: "sm", variant: "ghost", tooltip: "The draft replaces the pending review on GitHub", onClick: (_e, cx) => this.pending(cx, p, "push", { force: true }) })))
      : null;
    return v_flex().gap(8).pt(4).border_t_1().border_color(alpha(k.border, 0.6))
      .child(h_flex().gap(10).items_center()
        .child(Toggle(`rv-sync-${keyOf(p)}`, on, (cx) => this.pending(cx, p, on ? "off" : "push")))
        .child(v_flex().flex_1().min_w(0).gap(1).child(div().text_size(TEXT.sm).text_color(k.foreground).child("Keep in sync as a pending review on GitHub")).child(div().text_size(TEXT.xs).text_color(st.error ? k.warning : k.dim).whitespace_normal().child(status)))
        .when(Boolean(st.busy), (x) => x.child(Spinner({ size: 12 })))
        .when(on && !st.busy, (x) => x.child(Button(`rv-sync-now-${keyOf(p)}`, { icon: "refresh-cw", size: "icon-sm", variant: "ghost", tooltip: "Check GitHub now", onClick: (_e, cx) => this.pending(cx, p, "status") }))))
      .children([box].filter(Boolean));
  }

  /** The review box, like GitHub's "Leave a comment": a summary, a verdict, the pending line comments, then Save draft or Post. */
  section(k, p, { agentButton } = {}) {
    const e = this.m.get(keyOf(p));
    if (!e) return div().text_size(TEXT.xs).text_color(k.dim).child("Reading the draft…");
    const showPreview = this.preview.has(keyOf(p));
    const { lines, replies } = this.counts(e);
    const text = e.summary.value().trim();
    const empty = !lines && !replies && !text && e.verdict === "COMMENT";
    const tone = e.verdict === "APPROVE" ? k.success : e.verdict === "REQUEST_CHANGES" ? k.destructive : k.mutedFg;
    const frame = (...kids) => v_flex().gap(10).p(14).rounded(RADIUS.lg).border_1().border_color(e.exists ? alpha(k.info, 0.5) : k.border).bg(e.exists ? alpha(k.info, 0.04) : k.card).children(kids.filter(Boolean));
    const head = (extra = []) => h_flex().gap(8).items_center().child(div().text_size(TEXT.base).font_semibold().child("Your review")).when(e.exists, (x) => x.child(Badge("draft", "secondary"))).child(div().flex_1()).children(extra.filter(Boolean));
    const setVerdict = (v, cx) => { e.verdict = v; this.begin(cx, e); cx.notify(); };
    const actions = h_flex().gap(8).items_center().children([
      e.exists ? Button("rv-preview", { label: showPreview ? "Back to editing" : "Preview", icon: showPreview ? "pencil" : "eye", size: "sm", variant: "ghost", onClick: (_e, cx) => { showPreview ? this.preview.delete(keyOf(p)) : this.preview.add(keyOf(p)); cx.notify(); } }) : null,
      e.exists ? Button("rv-discard", { label: "Discard", size: "sm", variant: "ghost", onClick: (_e, cx) => this.discard(cx, p) }) : null,
      Button("rv-save", { label: "Save draft", size: "sm", variant: "outline", disabled: empty, onClick: (_e, cx) => { e.chain = e.chain.then(() => this.save(e)).catch(() => {}); notify({ title: "Draft saved", body: `${keyOf(p)} · it stays here until you post it` }); cx.notify(); } }),
      Button("rv-post", { label: this.busy === keyOf(p) ? "Posting…" : "Post review…", size: "sm", disabled: this.busy === keyOf(p) || empty, onClick: (_e, cx) => ((this.confirm = { p }), cx.notify()) }),
    ].filter(Boolean));
    const syncRow = this.syncRow(k, p, e);
    if (showPreview) {
      const verb = e.verdict === "APPROVE" ? "approved these changes" : e.verdict === "REQUEST_CHANGES" ? "requested changes" : "reviewed";
      return frame(
        head(),
        div().text_size(TEXT.xs).text_color(k.dim).child("This is what GitHub will get. Nothing is sent until you post it."),
        v_flex().gap(8).p(12).rounded(RADIUS.md).border_1().border_color(k.border).bg(k.card)
          .child(h_flex().gap(8).items_center().child(div().text_size(TEXT.sm).font_semibold().child("You")).child(div().text_size(TEXT.sm).text_color(tone).child(verb)))
          .child(text ? this.md(`rv-md-sum-${keyOf(p)}`, text) : div().text_size(TEXT.sm).text_color(k.dim).child("No summary.")),
        ...e.rows.filter((r) => r.body.value().trim()).map((r) => {
          // As GitHub shows a pending comment: the file and lines on top, the code with the commented lines marked, then the comment.
          const g = parseRange(r.line.value());
          return v_flex().id(`rv-pv-${r.id}`).rounded(RADIUS.md).border_1().border_color(k.border).bg(k.card).overflow_hidden()
            .child(h_flex().gap(8).px(10).py(6).items_center().bg(k.muted).border_b_1().border_color(k.border)
              .children(r.reply_to ? [Badge("reply", "secondary"), div().flex_1().min_w(0).truncate().text_size(TEXT.xs).text_color(k.dim).child(r.quote ?? "in the thread")] : [Mono(r.path.value(), { size: TEXT.xs, color: k.foreground }), div().flex_1(), div().text_size(TEXT.xs).text_color(k.dim).child(g ? (g.start === g.end ? `line ${g.start}` : `lines ${g.start}–${g.end}`) : "no line")]))
            .children([!r.reply_to ? this.snippet(k, p, r.path.value().trim(), r.line.value()) : null].filter(Boolean))
            .child(v_flex().gap(6).p(10)
              .child(h_flex().gap(8).items_center().child(div().size(20).flex_none().rounded(10).flex().items_center().justify_center().bg(alpha(k.info, 0.18)).text_size(10).font_semibold().text_color(k.info).child("Y")).child(div().text_size(TEXT.sm).font_semibold().child("You")).child(Badge("Pending", "warning")).child(div().flex_1()).child(this.whyButton(r)))
              .child(this.md(`rv-md-${r.id}`, r.body.value()))
              .children([this.whyPanel(k, p, r)].filter(Boolean)));
        }),
        div().text_size(TEXT.xs).text_color(k.dim).child(`${lines} line comment${lines === 1 ? "" : "s"} and ${replies} repl${replies === 1 ? "y" : "ies"}; empty ones are left out.`),
        syncRow,
        h_flex().justify_end().child(actions),
      );
    }
    return frame(
      head(),
      this.box(k, e.summary),
      e.rows.length ? div().text_size(TEXT.xs).font_semibold().text_color(k.mutedFg).child(`Pending comments · ${e.rows.length}`) : null,
      ...e.rows.map((r) =>
        v_flex().id(`rv-row-${r.id}`).gap(6).p(10).rounded(RADIUS.md).border_1().border_color(k.border).bg(k.card)
          .child(
            h_flex().gap(6).items_center()
              .children(
                r.reply_to
                  ? [Badge("reply", "secondary"), div().flex_1().min_w(0).truncate().text_size(TEXT.xs).text_color(k.dim).child(r.quote ?? "to a thread")]
                  : [div().flex_1().min_w(120).px(8).py(4).flex().items_center().rounded(RADIUS.sm).border_1().border_color(k.input).bg(k.background).child(Input.new(r.path).flex_1().text_size(TEXT.xs).text_color(k.foreground)), div().text_color(k.dim).child(":"), div().min_w(72).px(8).py(4).flex().items_center().rounded(RADIUS.sm).border_1().border_color(k.input).bg(k.background).tooltip("A line, or a range: 12-18").child(Input.new(r.line).flex_1().text_size(TEXT.xs).text_color(k.foreground))],
              )
              .children(r.reply_to ? [] : [this.whyButton(r)])
              .child(Button(`rv-rm-${r.id}`, { label: "Remove", size: "sm", variant: "ghost", onClick: (_e, cx) => { e.rows = e.rows.filter((x) => x !== r); this.queueSave(cx, e); cx.notify(); } })),
          )
          .children([!r.reply_to ? this.snippet(k, p, r.path.value().trim(), r.line.value()) : null].filter(Boolean))
          .child(this.box(k, r.body))
          .children([this.whyPanel(k, p, r)].filter(Boolean)),
      ),
      syncRow,
      h_flex().gap(8).items_center().child(Button("rv-add", { label: "Add a line comment", icon: "plus", size: "sm", variant: "ghost", onClick: (_e, cx) => this.addComment(cx, p) })).children([agentButton].filter(Boolean)).child(div().flex_1()).child(Tabs("rv-verdict", { value: e.verdict, onChange: setVerdict, items: VERDICTS.map(([value, label]) => ({ value, label })) })),
      h_flex().justify_end().child(actions),
    );
  }
}
