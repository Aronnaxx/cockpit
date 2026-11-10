// Pull requests on Home: yours (whose move it is, approvals, reviewers, CI, behind main) and the ones you are asked to review.
// Data: prsdata.js. Agents start from here the way they do on the PRs page (agentlaunch.js); nothing is posted to GitHub.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { notify, setShared } from "herdr";
import { tokens, alpha, TEXT, RADIUS, Button, Mono, StageHeading, openMenu } from "./ui.js";
import { ago } from "./prsdata.js";
import { LAUNCH_AGENTS, launchAgent, lastAgent, prPrompt, repoFolder } from "./agentlaunch.js";

export const prKey = (p) => `${p.repo}#${p.number}`;

const WHY = { review: "REVIEW", "re-review": "RE-REVIEW", ci: "FIX CI", changes: "YOUR MOVE", comments: "YOUR MOVE", merge: "READY TO MERGE", draft: "DRAFT", reviewers: "ASK REVIEWERS" };

/** What cannot wait on an author's own pull request, whoever's move it is: changes asked, CI failing. */
export function urgent(p) {
  if (p.role !== "author") return null;
  if (p.decision === "CHANGES_REQUESTED") return { label: "CHANGES ASKED", tone: "destructive" };
  if ((p.ci?.failed?.length ?? 0) > 0) return { label: "CI FAILING", tone: "destructive" };
  if ((p.behind ?? 0) > 0) return { label: p.behind >= 20 ? `${p.behind} BEHIND MAIN` : "BEHIND MAIN", tone: p.behind >= 20 ? "destructive" : "warning" };
  return null;
}

/** Urgent ones first, red before amber. */
export const urgency = (p) => { const u = urgent(p); return u ? (u.tone === "destructive" ? 2 : 1) : 0; };

/** Red when it is on you to fix, amber when it is on you for anything else, blue while it waits on someone, grey otherwise. */
export function turnColor(k, t) {
  return t?.who === "you" ? (t.why === "ci" || t.why === "changes" ? k.destructive : t.why === "merge" ? k.success : k.warning) : t?.who === "them" ? k.info : k.border;
}

export function turnLabel(t) {
  return t?.who === "you" ? WHY[t.why] ?? "YOUR MOVE" : t?.who === "them" ? (t.why === "re-requested" ? "WAITING · RE-REQUESTED" : "WAITING ON THEM") : "";
}

/** The agent choice for a card: kind = fix | rebase | review | rereview. The menu's command comes back to Home.command. */
export function agentMenu(kind, p) {
  openMenu(LAUNCH_AGENTS.map((a) => ({ label: a.label, icon: "bot", command: `home:prs:${kind}:${a.id}:${prKey(p)}` })), { width: 220 });
}

/** Handles `home:prs:<kind>:<agent>:<owner/name#n>` (the rest after "home:prs:"). */
export function startFromHome(rest, list, cfg, cx) {
  const [kind, agent, ...key] = rest.split(":");
  const p = list.find((x) => prKey(x) === key.join(":"));
  if (!p) return;
  cx.spawn(async (cx) => {
    const ok = await launchAgent({ agent, prompt: prPrompt(kind, p), folder: repoFolder(p.repo, cfg), name: `${kind} ${p.repo.split("/")[1]}#${p.number}` });
    if (ok) notify({ title: "Agent started", body: `${LAUNCH_AGENTS.find((a) => a.id === agent)?.label ?? agent} is on ${prKey(p)}.` });
    cx.notify();
  });
}

/** A pull request's page on the PRs tab. */
export function openDetails(p, show) {
  setShared("cockpit.prs.focus", prKey(p));
  show("prs");
}

function chip(k, text, color, mono = false) {
  return div().flex_none().px(7).h(20).flex().items_center().rounded(RADIUS.sm).text_size(TEXT.xs).bg(alpha(color, 0.14)).text_color(color).child(mono ? Mono(text, { size: TEXT.xs, color }) : text);
}

/** One pull request: repository and branch, whose move it is (and why), approvals, CI, behind main, last activity, every reviewer. */
export function PrCard(p, { show, openUrl }) {
  const k = tokens();
  const t = p.turn;
  const hot = urgent(p);
  const c = hot ? k[hot.tone] : turnColor(k, t);
  const you = t?.who === "you";
  const author = p.role === "author";
  const approvals = `${p.approvals}/${p.required} approvals`;
  const failed = p.ci?.failed?.length ?? 0;
  const reviewers = (p.reviewers ?? []).filter((r) => r.login);
  const actions = [
    author
      ? Button(`hp-${prKey(p)}-fix`, { label: failed || t?.why === "changes" || t?.why === "comments" ? "Fix with agent…" : "Work with agent…", variant: you ? "default" : "outline", size: "sm", onClick: () => agentMenu("fix", p) })
      : Button(`hp-${prKey(p)}-review`, { label: t?.why === "re-review" ? "Re-review with agent…" : "Review with agent…", variant: you ? "default" : "outline", size: "sm", onClick: () => agentMenu(t?.why === "re-review" ? "rereview" : "review", p) }),
    author && (p.behind ?? 0) > 0 ? Button(`hp-${prKey(p)}-rebase`, { label: `Rebase (${p.behind} behind)`, variant: "outline", size: "sm", onClick: () => agentMenu("rebase", p) }) : null,
    Button(`hp-${prKey(p)}-details`, { label: "Details", variant: "ghost", size: "sm", onClick: () => openDetails(p, show) }),
    Button(`hp-${prKey(p)}-open`, { label: "Open PR", variant: "ghost", size: "sm", onClick: (_e, cx) => openUrl(cx, p.url) }),
  ].filter(Boolean);
  return v_flex()
    .id(`hp-${prKey(p)}`)
    .size_full()
    .gap(8)
    .p(14)
    .rounded(RADIUS.lg)
    .border_1()
    .border_color(k.border)
    .bg(k.card)
    .border_l(3)
    .border_color(c)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(chip(k, p.repo.split("/")[1], k.info))
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.xs).text_color(k.dim).child(p.branch))
        .when(Boolean(hot), (e) => e.child(div().flex_none().px(6).h(16).flex().items_center().rounded(4).text_size(9.5).font_semibold().bg(alpha(k[hot.tone], 0.2)).text_color(k[hot.tone]).child(hot.label)))
        .when(Boolean(turnLabel(t)), (e) => e.child(div().flex_none().px(6).h(16).flex().items_center().rounded(4).text_size(9.5).font_semibold().bg(alpha(c, you ? 0.16 : 0.12)).text_color(you ? c : k.mutedFg).child(turnLabel(t)))),
    )
    .child(div().text_size(TEXT.base).font_medium().text_color(k.foreground).child(p.title))
    .when(Boolean(t?.detail), (e) => e.child(div().text_size(TEXT.sm).text_color(you || hot ? c : k.mutedFg).child(t.detail)))
    .child(
      h_flex()
        .gap(6)
        .flex_wrap()
        .child(chip(k, `#${p.number}`, k.mutedFg, true))
        .child(chip(k, approvals, p.approvals >= p.required ? k.success : k.mutedFg))
        .child(failed ? chip(k, `CI: ${failed} failed`, k.destructive) : p.ci?.state === "pending" || p.ci?.pending ? chip(k, "CI running", k.warning) : chip(k, "CI passing", k.success))
        .when(author && (p.behind ?? 0) > 0, (e) => e.child(chip(k, `${p.behind} behind main`, k.warning)))
        .when((p.unresolved ?? 0) > 0, (e) => e.child(chip(k, `${p.unresolved} unresolved`, k.warning)))
        .child(chip(k, `active ${ago(p.last_activity)}`, k.mutedFg)),
    )
    .when(reviewers.length > 0, (e) =>
      e.child(
        div().truncate().text_size(TEXT.xs).text_color(k.dim).child(
          reviewers.slice(0, 4).map((r) => `${r.login} ${r.re_requested ? "re-requested" : String(r.state ?? "").toLowerCase().replace(/_/g, " ") || "—"}${r.comments ? ` · ${r.comments}💬` : ""}`).join("   ·   "),
        ),
      ),
    )
    .child(div().flex_1())
    .child(h_flex().gap(8).flex_wrap().children(actions));
}

/** The pull requests that need you, mine then to review, in a grid of equal cells; the rest wait on others (the PRs page has them). */
export function PrSections(d, { narrow, show, openUrl }) {
  const k = tokens();
  const order = (a, b) => (urgency(b) - urgency(a)) || (b.turn?.who === "you") - (a.turn?.who === "you") || b.last_activity - a.last_activity;
  const needs = (p) => p.turn?.who === "you" || urgency(p) > 0;
  const mineAll = d?.mine ?? [];
  const theirsAll = (d?.assigned ?? []).filter((p) => p.turn?.who !== "none");
  const mine = mineAll.filter(needs).sort(order);
  const theirs = theirsAll.filter((p) => p.turn?.who === "you").sort(order);
  const cols = narrow ? 1 : 2;
  const grid = (items) => {
    const rows = [];
    for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
    return v_flex().w_full().gap(14).children(rows.map((r, i) => h_flex().id(`pr-row-${i}-${prKey(r[0])}`).w_full().gap(14).items_stretch().children([...r.map((p) => div().flex_1().min_w(0).flex().child(PrCard(p, { show, openUrl }))), ...Array.from({ length: cols - r.length }, (_, j) => div().id(`pr-pad-${i}-${j}`).flex_1().min_w(0))])));
  };
  const more = (n, label) => (n > 0 ? h_flex().id(`pr-more-${label}`).gap(6).items_center().cursor_pointer().text_size(TEXT.sm).text_color(k.mutedFg).hover((s) => s.text_color(k.foreground)).on_click(() => show("prs")).child(`${n} more ${label} →`) : null);
  const section = (id, label, color, items, rest, restLabel) =>
    items.length || rest > 0
      ? v_flex().gap(10).child(StageHeading(id, label, { color, count: items.length })).children([items.length ? grid(items) : div().text_size(TEXT.sm).text_color(k.dim).child("Nothing needs you here."), more(rest, restLabel)].filter(Boolean))
      : null;
  return v_flex()
    .gap(18)
    .children([section("head-your-prs", "Your PRs · needs you", k.info, mine, mineAll.length - mine.length, "waiting on others"), section("head-reviews", "Reviews · needs you", k.warning, theirs, theirsAll.length - theirs.length, "you've reviewed or aren't asked yet")].filter(Boolean));
}
