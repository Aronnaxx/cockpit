// The Comments page of the side panel: for the pull request the focused agent works on (a tab named "review mono#1937",
// or a worktree on the PR's branch), the review draft being written (verdict, summary, pending line comments) and the
// open review threads. "Open beside" puts the PR's page in a pane next to the agent (Full page: the Pull requests page), where
// the draft is edited and posted. Nothing is posted here.

import { div } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { exec, focused, agents, spaces, panes, readTextFile } from "herdr";
import * as hub from "./hub.js";
import { tokens, alpha, TEXT, RADIUS, Badge, Button, Empty, Mono, Spinner, Icon } from "./ui.js";
import { prBeside } from "./beside.js";
import { prs, ago } from "./prsdata.js";
import { show } from "./sidebar.js";
import { openDetails, reviewOf } from "./prcards.js";
import { draftFile } from "./prreview.js";

const keyOf = (p) => `${p.repo}#${p.number}`;

export default class Comments {
  init(_p, cx) {
    this.draft = new Map();
    this.open = new Set();
    this.threads = new Map();
    const tick = (cx) => {
      const p = this.pr();
      if (!p) return;
      cx.spawn(async (cx) => {
        try {
          const { home } = await hub.install();
          const text = await readTextFile(draftFile(home, p)).catch(() => null);
          const d = text ? JSON.parse(text) : null;
          const before = JSON.stringify(this.draft.get(keyOf(p)) ?? null);
          this.draft.set(keyOf(p), d);
          if (before !== JSON.stringify(d)) cx.notify();
          const t = this.threads.get(keyOf(p));
          if (!t || Date.now() - t.at > 60000) {
            this.threads.set(keyOf(p), { at: Date.now(), items: t?.items ?? null });
            const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-pr-comments.py`, p.repo, String(p.number)], { timeout: 90000 });
            this.threads.set(keyOf(p), { at: Date.now(), items: (JSON.parse(r.stdout || "{}").items ?? []).filter((i) => i.kind === "thread") });
            cx.notify();
          }
        } catch {}
      });
    };
    tick(cx);
    cx.timer.every(3000, tick);
    cx.timer.every(2000, (cx) => cx.notify());
  }

  command() {}

  /** The pull request the focused agent is on. */
  pr() {
    const f = focused();
    const a = agents().find((x) => x.focused) ?? agents().find((x) => x.address === f?.terminal);
    const tab = a ? spaces().flatMap((s) => s.tabs).find((t) => t.id === a.tab)?.name : null;
    const hit = tab ? reviewOf(tab) : null;
    const branch = panes().find((p) => p.terminal === f?.terminal)?.branch;
    const d = prs();
    const found = hit ?? (branch ? [...(d?.mine ?? []), ...(d?.assigned ?? [])].find((p) => p.branch === branch) ?? null : null);
    // The focus on something that is not a terminal (the PR's own pane beside the agent, a panel): the last one stays.
    if (found) this.last = found;
    return found ?? (!f?.terminal ? this.last ?? null : null);
  }

  render() {
    const k = tokens();
    const p = this.pr();
    const shell = (...kids) => v_flex().id("comments").size_full().overflow_y_scrollbar().p(12).gap(12).bg(k.background).text_color(k.foreground).children(kids.filter(Boolean));
    if (!p) return shell(Empty({ icon: "message-circle", title: "No pull request here", description: "Focus an agent started from a pull request's page (a tab named “review mono#123”, or one in its worktree) to see its comments and review draft." }));
    const d = this.draft.get(keyOf(p));
    const t = this.threads.get(keyOf(p));
    const verdict = String(d?.verdict ?? "COMMENT");
    const tone = verdict === "APPROVE" ? k.success : verdict === "REQUEST_CHANGES" ? k.destructive : k.info;
    const rows = (d?.comments ?? []).map((c, i) => ({ ...c, i })).filter((c) => String(c.body ?? "").trim());
    const lines = rows.filter((c) => !c.reply_to);
    const why = lines.filter((c) => c.why).length;
    const open = (t?.items ?? []).filter((i) => !i.resolved);
    const working = agents().some((a) => a.status === "working" && reviewOf(spaces().flatMap((s) => s.tabs).find((x) => x.id === a.tab)?.name) === p);
    const pill = (text, color) => div().flex_none().px(7).h(18).flex().items_center().rounded(9).text_size(10.5).font_medium().bg(alpha(color, 0.14)).text_color(color).child(text);
    const section = (title, extra) => h_flex().gap(8).items_center().pt(4).child(div().text_size(TEXT.xs).font_semibold().text_color(k.mutedFg).child(title.toUpperCase())).child(div().flex_1().h(1).bg(k.border)).children([extra].filter(Boolean));
    const range = (c) => (c.start_line && c.start_line < c.line ? `${c.start_line}–${c.line}` : c.line ? String(c.line) : "");
    // One comment: its lines and the start of what it says; a click opens the whole of it and the agent's reason.
    const item = (c) => {
      const id = `cm-${keyOf(p)}-${c.i}`;
      const on = this.open.has(id);
      const text = String(c.body);
      return v_flex().id(id).gap(6).px(10).py(8).rounded(RADIUS.md).cursor_pointer().bg(on ? k.card : alpha(k.card, 0)).border_1().border_color(on ? k.border : alpha(k.border, 0)).hover((x) => x.bg(k.card))
        .on_click((_e, cx) => { on ? this.open.delete(id) : this.open.add(id); cx.notify(); })
        .child(h_flex().gap(8).items_start()
          .child(div().flex_none().mt(1).px(5).h(16).flex().items_center().rounded(4).bg(alpha(k.warning, 0.14)).text_size(10).font_family("JetBrains Mono").text_color(k.warning).child(c.reply_to ? "reply" : range(c) || "file"))
          .child(div().flex_1().min_w(0).text_size(TEXT.sm).text_color(k.foreground).whitespace_normal().child(on ? "" : text.length > 150 ? `${text.slice(0, 150)}…` : text))
          .when(Boolean(c.why) && !on, (e) => e.child(div().flex_none().tooltip("The agent left its reason: click to read it").child(Icon("circle-help", { size: 13, color: k.info })))))
        .when(on, (e) => e
          .child(TextView.markdown(`${id}-md`, text).selectable(true).w_full())
          .when(Boolean(c.why), (x) => x.child(v_flex().gap(2).p(8).rounded(RADIUS.sm).border_l_2().border_color(k.info).bg(alpha(k.info, 0.06)).child(div().text_size(TEXT.xs).font_semibold().text_color(k.info).child("Why the agent made it")).child(TextView.markdown(`${id}-why`, c.why).selectable(true).w_full()))));
    };
    const files = [...new Set(lines.map((c) => c.path))];
    return shell(
      // The pull request: where it is, what the draft says, and the ways to open it.
      v_flex().gap(8).p(12).rounded(RADIUS.lg).border_1().border_color(k.border).bg(k.card)
        .child(h_flex().gap(6).items_center().child(Icon("git-pull-request", { size: 13, color: k.mutedFg })).child(Mono(`${p.repo.split("/")[1]}#${p.number}`, { size: TEXT.xs, color: k.mutedFg })).child(div().flex_1()).when(working, (e) => e.child(h_flex().gap(4).items_center().child(Spinner({ size: 10, color: k.working })).child(div().text_size(TEXT.xs).text_color(k.mutedFg).child("agent reviewing")))))
        .child(div().text_size(TEXT.base).font_semibold().whitespace_normal().child(p.title))
        .child(h_flex().gap(6).flex_wrap().child(pill(d ? verdict.toLowerCase().replace("_", " ") : "no draft yet", d ? tone : k.mutedFg)).when(Boolean(d), (e) => e.child(pill(`${lines.length} comment${lines.length === 1 ? "" : "s"}`, k.mutedFg)).when(lines.length > 0, (x) => x.child(pill(`${why}/${lines.length} with a reason`, why === lines.length ? k.success : k.warning)))).when(Boolean(t?.items), (e) => e.child(pill(`${open.length} open thread${open.length === 1 ? "" : "s"}`, open.length ? k.warning : k.mutedFg))))
        .child(h_flex().gap(6).pt(2)
          .child(Button("cm-beside", { label: "Open beside", icon: "columns", size: "sm", tooltip: "The PR's page in a pane next to this agent: zoom it to full size, or close it, from its header", onClick: () => prBeside(p) }))
          .child(Button("cm-open", { label: "Full page", icon: "maximize", size: "sm", variant: "outline", onClick: () => openDetails(p, show) }))
          .child(div().flex_1())
          .child(Button("cm-url", { icon: "external", size: "icon-sm", variant: "ghost", tooltip: "On GitHub", onClick: (_e, cx) => cx.spawn(async () => hub.openUrl(p.url)) }))),
      d?.summary ? v_flex().gap(4).child(section("Summary")).child(div().px(2).text_size(TEXT.sm).text_color(k.foreground).whitespace_normal().child(d.summary.length > 360 ? `${d.summary.slice(0, 360)}…` : d.summary)) : null,
      !d ? h_flex().gap(8).p(10).items_center().rounded(RADIUS.md).bg(alpha(k.muted, 0.6)).text_color(k.mutedFg).text_size(TEXT.sm).child(Spinner({ size: 12 })).child("No draft yet. The agent's comments appear here as it writes them.") : null,
      ...files.flatMap((f) => [
        h_flex().id(`cm-f-${f}`).gap(6).items_center().pt(4).child(Icon("file-text", { size: 12, color: k.dim })).child(div().flex_1().min_w(0).truncate().text_size(TEXT.xs).font_family("JetBrains Mono").text_color(k.mutedFg).child(f)).child(div().text_size(TEXT.xs).text_color(k.dim).child(String(lines.filter((c) => c.path === f).length))),
        v_flex().gap(2).children(lines.filter((c) => c.path === f).sort((a, b) => (a.start_line ?? a.line ?? 0) - (b.start_line ?? b.line ?? 0)).map(item)),
      ]),
      rows.some((c) => c.reply_to) ? v_flex().gap(2).child(section("Replies")).children(rows.filter((c) => c.reply_to).map(item)) : null,
      section("Open threads", t?.items ? div().text_size(TEXT.xs).text_color(k.dim).child(String(open.length)) : null),
      !t?.items
        ? h_flex().gap(8).items_center().text_color(k.mutedFg).text_size(TEXT.sm).child(Spinner({ size: 12 })).child("Reading the conversation…")
        : open.length
          ? v_flex().gap(6).children(open.slice(0, 12).map((i, n) => v_flex().id(`cm-t-${n}`).gap(4).p(10).rounded(RADIUS.md).border_1().border_color(k.border).bg(k.card).child(h_flex().gap(6).items_center().child(Mono(`${String(i.path).split("/").pop()}${i.line ? `:${i.line}` : ""}`, { size: TEXT.xs, color: k.foreground })).child(div().flex_1()).child(div().text_size(TEXT.xs).text_color(k.dim).child(`${i.comments.length} · ${ago(i.at)} ago`))).child(div().text_size(TEXT.xs).text_color(k.mutedFg).whitespace_normal().child(`${i.author}: ${(i.comments?.[0]?.body ?? "").slice(0, 200)}`))))
          : div().text_size(TEXT.sm).text_color(k.dim).child("No open threads."),
    );
  }
}
