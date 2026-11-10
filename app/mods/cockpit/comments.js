// The Comments page of the side panel: for the pull request the focused agent works on (a tab named "review mono#1937",
// or a worktree on the PR's branch), the review draft being written (verdict, summary, pending line comments) and the
// open review threads. "Open the review" goes to the PR's page, where the draft is edited and posted. Nothing is posted here.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, focused, agents, spaces, panes, readTextFile } from "herdr";
import * as hub from "./hub.js";
import { tokens, alpha, TEXT, RADIUS, Badge, Button, Empty, Mono, Spinner } from "./ui.js";
import { prs, ago } from "./prsdata.js";
import { show } from "./sidebar.js";
import { openDetails, reviewOf } from "./prcards.js";
import { draftFile } from "./prreview.js";

const keyOf = (p) => `${p.repo}#${p.number}`;

export default class Comments {
  init(_p, cx) {
    this.draft = new Map();
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
    if (hit) return hit;
    const branch = panes().find((p) => p.terminal === f?.terminal)?.branch;
    const d = prs();
    return branch ? [...(d?.mine ?? []), ...(d?.assigned ?? [])].find((p) => p.branch === branch) ?? null : null;
  }

  render() {
    const k = tokens();
    const p = this.pr();
    const shell = (...kids) => v_flex().id("comments").size_full().overflow_y_scrollbar().p(14).gap(12).bg(k.background).text_color(k.foreground).children(kids.filter(Boolean));
    if (!p) return shell(Empty({ icon: "message-circle", title: "No pull request here", description: "Focus an agent started from a pull request's page (a tab named “review mono#123”, or one in its worktree) to see its comments and review draft." }));
    const d = this.draft.get(keyOf(p));
    const t = this.threads.get(keyOf(p));
    const tone = d?.verdict === "APPROVE" ? k.success : d?.verdict === "REQUEST_CHANGES" ? k.destructive : k.mutedFg;
    const rows = (d?.comments ?? []).filter((c) => String(c.body ?? "").trim());
    const open = (t?.items ?? []).filter((i) => !i.resolved);
    const card = (...kids) => v_flex().gap(6).p(10).rounded(RADIUS.md).border_1().border_color(k.border).bg(k.card).children(kids.filter(Boolean));
    return shell(
      v_flex().gap(2).child(Mono(keyOf(p), { size: TEXT.xs, color: k.mutedFg })).child(div().text_size(TEXT.base).font_semibold().whitespace_normal().child(p.title)),
      h_flex().gap(6).child(Button("cm-open", { label: "Open the review", icon: "git-pull-request", size: "sm", onClick: () => openDetails(p, show) })).child(Button("cm-url", { label: "Open PR", variant: "ghost", size: "sm", onClick: (_e, cx) => cx.spawn(async () => hub.openUrl(p.url)) })),
      h_flex().gap(8).items_center().child(div().text_size(TEXT.sm).font_semibold().child("Review draft")).children(d ? [Badge(String(d.verdict ?? "COMMENT").toLowerCase().replace("_", " "), "secondary"), Badge(`${rows.length} comment${rows.length === 1 ? "" : "s"}`, "secondary")] : []),
      d
        ? card(div().text_size(TEXT.sm).text_color(d.summary ? k.foreground : k.dim).whitespace_normal().child(d.summary ? (d.summary.length > 420 ? `${d.summary.slice(0, 420)}…` : d.summary) : "No summary yet."))
        : card(h_flex().gap(8).items_center().text_color(k.mutedFg).text_size(TEXT.sm).child(Spinner({ size: 12 })).child("No draft yet. The agent's comments appear here as it writes them.")),
      ...rows.map((c, i) => card(c.reply_to ? h_flex().gap(6).child(Badge("reply", "secondary")).child(div().flex_1().min_w(0).truncate().text_size(TEXT.xs).text_color(k.dim).child(c.quote ?? "in a thread")) : Mono(`${c.path}${c.line ? `:${c.line}` : ""}`, { size: TEXT.xs, color: k.foreground }), div().id(`cm-d-${i}`).text_size(TEXT.sm).text_color(k.mutedFg).whitespace_normal().child(c.body.length > 260 ? `${c.body.slice(0, 260)}…` : c.body))),
      div().text_size(TEXT.sm).font_semibold().child(`Open threads${t?.items ? ` · ${open.length}` : ""}`),
      !t?.items ? h_flex().gap(8).items_center().text_color(k.mutedFg).text_size(TEXT.sm).child(Spinner({ size: 12 })).child("Reading the conversation…") : open.length ? v_flex().gap(6).children(open.slice(0, 12).map((i, n) => card(Mono(`${i.path}${i.line ? `:${i.line}` : ""}`, { size: TEXT.xs, color: k.foreground }), div().id(`cm-t-${n}`).text_size(TEXT.xs).text_color(k.mutedFg).whitespace_normal().child(`${i.author}: ${(i.comments?.[0]?.body ?? "").slice(0, 200)}`), div().text_size(TEXT.xs).text_color(k.dim).child(`${i.comments.length} comment${i.comments.length === 1 ? "" : "s"} · ${ago(i.at)} ago`)))) : div().text_size(TEXT.sm).text_color(k.dim).child("No open threads."),
    );
  }
}
