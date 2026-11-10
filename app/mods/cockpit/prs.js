// The Pull requests tab: yours and the ones you review, each with whose move it is, the approvals it has of what it needs,
// every reviewer with their state, last activity and comments, its CI (the failed jobs, and a button to retry just those),
// how far behind main it is (it is brought up by rebasing, never merging), and a place to start an agent on it: which agent,
// which model, which preset, what task. Nothing is ever posted to GitHub from here. Data: prsdata.js.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { exec, notify } from "herdr";
import * as hub from "./hub.js";
import { tokens, alpha, TEXT, RADIUS, Badge, Button, Card, PageHeader, Empty, Mono, Progress, Spinner, TextField } from "./ui.js";
import { loadPrs, prs, prsConfig, ago } from "./prsdata.js";
import { LAUNCH_AGENTS, launchAgent, lastAgent, prPrompt, repoFolder } from "./agentlaunch.js";
import { OmoModel } from "./agentsui.js";

const keyOf = (p) => `${p.repo}#${p.number}`;
const TASKS = {
  author: [["fix", "Address comments and CI"], ["rebase", "Rebase onto main"]],
  reviewer: [["review", "Review it"], ["rereview", "Re-review (only what changed)"]],
};

export default class Prs {
  init(_p, cx) {
    this.sel = null;
    this.ci = new Map();
    this.cfg = {};
    this.busy = null;
    this.agent = lastAgent();
    this.task = null;
    this.model = InputState.new({ placeholder: "model (optional, e.g. opus, gpt-6.1-sol)" });
    this.omo = new OmoModel();
    this.omo.follow(cx);
    const pull = (cx, force) =>
      cx.spawn(async (cx) => {
        this.busy = force ? "refresh" : this.busy;
        cx.notify();
        await loadPrs({ force });
        this.cfg = await prsConfig();
        this.busy = null;
        cx.notify();
      });
    this.pull = pull;
    pull(cx, false);
    cx.timer.every(60000, (cx) => pull(cx, false));
  }

  command(c, cx) {
    // From a menu: prs:<kind>:<agent>:<owner/name#number>
    const m = c.match(/^prs:([a-z]+):([a-z-]+):(.+)$/);
    if (!m) return;
    const p = this.list().find((x) => keyOf(x) === m[3]);
    if (p) this.start(cx, p, m[1], m[2]);
  }

  list() {
    const d = prs();
    return [...(d?.mine ?? []), ...(d?.assigned ?? [])];
  }

  select(cx, p) {
    this.sel = keyOf(p);
    this.task = null;
    const url = p.ci?.builds?.[0];
    if (url && !this.ci.has(url)) {
      this.ci.set(url, "loading");
      this.readCi(cx, url);
    }
    cx.notify();
  }

  readCi(cx, url, retry = false) {
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-ci.py`, url, ...(retry ? ["--retry-failed"] : [])], { timeout: 120000 });
        const d = JSON.parse(r.stdout || "null");
        this.ci.set(url, d ?? { error: "no answer" });
        if (retry) notify({ title: d?.errors?.length ? "Some retries failed" : "CI", body: d?.error ?? `Retried ${d?.retried ?? 0} failed job${d?.retried === 1 ? "" : "s"}.${d?.errors?.length ? ` ${d.errors[0]}` : ""}` });
      } catch (e) {
        this.ci.set(url, { error: String(e?.message ?? e).slice(0, 160) });
      }
      cx.notify();
    });
  }

  /** Starts the picked agent (or `agent`) on a pull request with the task's prompt. */
  start(cx, p, kind, agent = this.agent) {
    cx.spawn(async (cx) => {
      const ok = await launchAgent({ agent, prompt: prPrompt(kind, { ...p, ci: { failed: this.failedJobs(p) } }), folder: repoFolder(p.repo, this.cfg), name: `${kind} ${p.repo.split("/")[1]}#${p.number}`, model: this.model.value().trim() || null });
      if (ok) notify({ title: "Agent started", body: `${LAUNCH_AGENTS.find((a) => a.id === agent)?.label ?? agent} is on ${keyOf(p)}.` });
      cx.notify();
    });
  }

  /** The failed jobs by name: Buildkite's when read, else the checks GitHub lists as failed. */
  failedJobs(p) {
    const d = this.ci.get(p.ci?.builds?.[0]);
    return d && d !== "loading" && d.failed ? d.failed : p.ci?.failed ?? [];
  }

  turnColor(k, t) {
    return t?.who === "you" ? (t.why === "ci" || t.why === "changes" ? k.destructive : k.warning) : t?.who === "them" ? k.info : k.border;
  }

  pill(k, p) {
    const t = p.turn;
    if (!t || t.who === "none") return null;
    const label = t.who === "you" ? { review: "REVIEW", "re-review": "RE-REVIEW", ci: "FIX CI", changes: "YOUR MOVE", comments: "YOUR MOVE", merge: "MERGE", draft: "DRAFT", reviewers: "ASK REVIEWERS" }[t.why] ?? "YOUR MOVE" : t.why === "re-requested" ? "WAITING · RE-REQUESTED" : "WAITING";
    const c = this.turnColor(k, t);
    return div().flex_none().px(6).h(16).flex().items_center().rounded(4).text_size(9.5).font_semibold().bg(alpha(c, t.who === "you" ? 0.16 : 0.12)).text_color(t.who === "you" ? c : k.mutedFg).child(label);
  }

  row(k, p) {
    const on = this.sel === keyOf(p);
    return v_flex()
      .id(`pr-${keyOf(p)}`)
      .gap(3)
      .px(10)
      .py(8)
      .rounded(RADIUS.md)
      .cursor_pointer()
      .border_1()
      .border_color(on ? k.ring : alpha(k.border, 0))
      .when(on, (e) => e.bg(k.selected))
      .when(!on, (e) => e.hover((x) => x.bg(k.accent)))
      .on_click((_e, cx) => this.select(cx, p))
      .child(h_flex().gap(6).items_center().child(Mono(`${p.repo.split("/")[1]}#${p.number}`, { size: TEXT.xs, color: k.mutedFg })).child(div().flex_1()).when(Boolean(this.pill(k, p)), (e) => e.child(this.pill(k, p))))
      .child(div().truncate().text_size(TEXT.sm).text_color(k.foreground).child(p.title))
      .child(
        h_flex()
          .gap(8)
          .text_size(TEXT.xs)
          .text_color(k.dim)
          .child(Mono(`${p.approvals}/${p.required}`, { size: TEXT.xs, color: p.approvals >= p.required ? k.success : k.mutedFg }))
          .child(div().child(`active ${ago(p.last_activity)}`))
          .when(p.role === "author" && (p.behind ?? 0) > 0, (e) => e.child(div().text_color(k.warning).child(`${p.behind} behind main`)))
          .when(p.ci.failed.length > 0, (e) => e.child(div().text_color(k.destructive).child(`CI: ${p.ci.failed.length} failed`))),
      );
  }

  detail(k, p, cx) {
    const t = p.turn;
    const tc = this.turnColor(k, t);
    const url = p.ci?.builds?.[0];
    const ci = url ? this.ci.get(url) : null;
    const failed = this.failedJobs(p);
    const section = (title, ...kids) => v_flex().gap(6).child(div().text_size(TEXT.sm).font_semibold().text_color(k.foreground).child(title)).children(kids.filter(Boolean));
    const stateChip = (r) => {
      const map = { approved: [k.success, "approved"], changes_requested: [k.destructive, "changes requested"], commented: [k.mutedFg, "commented"], "re-requested": [k.info, "re-requested"], requested: [k.mutedFg, "asked"] };
      const [c, label] = map[r.state] ?? [k.dim, r.state ?? "—"];
      return div().flex_none().px(6).h(16).flex().items_center().rounded(4).text_size(10).bg(alpha(c, 0.14)).text_color(c).child(label);
    };
    const agentRow = h_flex().gap(6).flex_wrap().children(LAUNCH_AGENTS.map((a) => Button(`prs-agent-${a.id}`, { label: a.label, size: "sm", variant: this.agent === a.id ? "default" : "outline", onClick: (_e, cx) => (this.agent = a.id, cx.notify()) })));
    const tasks = TASKS[p.role] ?? TASKS.author;
    const task = this.task ?? tasks[0][0];
    const taskRow = h_flex().gap(6).flex_wrap().children(tasks.map(([id, label]) => Button(`prs-task-${id}`, { label, size: "sm", variant: task === id ? "secondary" : "ghost", onClick: (_e, cx) => (this.task = id, cx.notify()) })));
    const here = this.omo.of(null);
    return v_flex()
      .id("pr-detail")
      .flex_1()
      .min_w(0)
      .gap(14)
      .child(
        v_flex()
          .gap(4)
          .child(h_flex().gap(8).items_center().child(Mono(`${p.repo}#${p.number}`, { color: k.mutedFg })).child(div().text_size(TEXT.xs).text_color(k.dim).child(`by ${p.author}`)).when(p.draft, (e) => e.child(Badge("draft", "warning"))))
          .child(div().text_size(18).font_semibold().whitespace_normal().child(p.title))
          .child(h_flex().gap(8).items_center().child(Mono(p.branch, { size: TEXT.xs, color: k.dim })).child(div().text_size(TEXT.xs).text_color(k.dim).child(`→ ${p.base}`)))
          .child(h_flex().gap(6).pt(4).child(Button("prs-open", { label: "Open PR", icon: "external", size: "sm", variant: "outline", onClick: (_e, cx) => cx.spawn(async () => hub.openUrl(p.url)) }))),
      )
      .child(
        h_flex()
          .gap(10)
          .p(12)
          .rounded(RADIUS.md)
          .border_l_2()
          .border_color(tc)
          .bg(alpha(tc, 0.07))
          .child(v_flex().flex_1().gap(2).child(div().text_size(TEXT.sm).font_semibold().text_color(t?.who === "you" ? tc : k.foreground).child(t?.who === "you" ? "Your move" : t?.who === "them" ? "Waiting on others" : "Nothing to do")).child(div().text_size(TEXT.sm).text_color(k.mutedFg).whitespace_normal().child(t?.detail || "")))
          .child(v_flex().gap(2).items_end().child(Mono(`${p.approvals}/${p.required}`, { size: 18, color: p.approvals >= p.required ? k.success : k.foreground })).child(div().text_size(TEXT.xs).text_color(k.dim).child("approvals"))),
      )
      .child(
        section(
          `Reviewers · ${p.reviewers.length}`,
          ...p.reviewers.map((r) =>
            h_flex()
              .id(`rv-${keyOf(p)}-${r.login}`)
              .gap(8)
              .items_center()
              .child(div().w(150).flex_none().truncate().text_size(TEXT.sm).text_color(k.foreground).child(r.login))
              .child(stateChip(r))
              .when(r.new_commits && r.state !== "approved", (e) => e.child(div().text_size(10).text_color(k.warning).child("new commits since")))
              .child(div().flex_1())
              .child(div().text_size(TEXT.xs).text_color(k.dim).child(r.last ? `last activity ${ago(r.last)}` : r.asked_at ? `asked ${ago(r.asked_at)}` : "no activity"))
              .child(div().w(70).flex_none().text_right().text_size(TEXT.xs).text_color(k.mutedFg).child(`${r.comments} comment${r.comments === 1 ? "" : "s"}`)),
          ),
          p.unresolved ? div().text_size(TEXT.xs).text_color(k.dim).child(`${p.unresolved} unresolved review thread${p.unresolved === 1 ? "" : "s"}`) : null,
        ),
      )
      .child(
        section(
          "CI",
          h_flex().gap(8).items_center().child(div().size(8).rounded(4).bg(p.ci.state === "success" ? k.success : p.ci.state === "failure" || p.ci.state === "error" ? k.destructive : k.warning)).child(div().text_size(TEXT.sm).text_color(k.foreground).child(ci && ci !== "loading" && ci.state ? `build ${ci.number}: ${ci.state}${ci.passed ? ` · ${ci.passed} passed` : ""}${ci.running ? ` · ${ci.running} running` : ""}` : p.ci.state)),
          ci === "loading" ? h_flex().gap(8).items_center().text_color(k.mutedFg).child(Spinner({ size: 12 })).child("Reading the build…") : null,
          ci?.error ? div().text_size(TEXT.xs).text_color(k.warning).child(ci.error) : null,
          ...failed.map((f, i) => div().id(`ci-f-${i}`).text_size(TEXT.xs).font_family("JetBrains Mono").text_color(k.destructive).truncate().child(`✗ ${f.name}`)),
          failed.length && url ? Button("prs-rerun", { label: `Re-run ${failed.length} failed job${failed.length === 1 ? "" : "s"}`, icon: "rotate-ccw", size: "sm", variant: "outline", onClick: (_e, cx) => (this.ci.set(url, "loading"), this.readCi(cx, url, true), cx.notify()) }) : null,
        ),
      )
      .when(p.role === "author", (e) =>
        e.child(
          section(
            "Up to date with main",
            div().text_size(TEXT.sm).text_color((p.behind ?? 0) > 0 ? k.warning : k.mutedFg).child((p.behind ?? 0) > 0 ? `${p.behind} commit${p.behind === 1 ? "" : "s"} behind ${p.base}. Always brought up by rebasing, never by merging.` : `Up to date with ${p.base}.`),
            (p.behind ?? 0) > 0 ? Button("prs-rebase", { label: "Rebase onto main with an agent", icon: "git-branch", size: "sm", variant: "outline", onClick: (_e, cx) => this.start(cx, p, "rebase") }) : null,
          ),
        ),
      )
      .child(
        Card({
          id: "prs-agent-card",
          padding: 14,
          gap: 10,
          title: "Work on it with an agent",
          children: [
            div().text_size(TEXT.xs).text_color(k.dim).child("Task"),
            taskRow,
            div().text_size(TEXT.xs).text_color(k.dim).child("Agent"),
            agentRow,
            div().text_size(TEXT.xs).text_color(k.dim).child("Model"),
            TextField(this.model),
            this.agent === "opencode" && here?.presets?.length
              ? v_flex().gap(6).child(div().text_size(TEXT.xs).text_color(k.dim).child("OMO preset (this computer; new sessions use it)")).child(h_flex().gap(6).flex_wrap().children(here.presets.map((n) => Button(`prs-omo-${n}`, { label: n, size: "sm", variant: n === here.preset ? "default" : "outline", onClick: (_e, cx) => cx.spawn(async (cx) => { const r = await this.omo.set(null, n); notify({ title: r.error ? "Could not change the preset" : "OMO preset", body: r.error ?? r.note }); cx.notify(); }) }))))
              : null,
            Button("prs-start", { label: `Start ${LAUNCH_AGENTS.find((a) => a.id === this.agent)?.label ?? this.agent}`, size: "sm", onClick: (_e, cx) => this.start(cx, p, task) }),
            div().text_size(TEXT.xs).text_color(k.dim).child("It starts in a new tab in the repository's folder. Nothing is posted to GitHub."),
          ].filter(Boolean),
        }),
      );
  }

  render(cx) {
    const k = tokens();
    const d = prs();
    const list = this.list();
    const group = (title, items) =>
      items.length
        ? v_flex()
            .gap(4)
            .child(div().px(10).pt(6).text_size(TEXT.xs).font_semibold().text_color(k.dim).child(`${title} · ${items.length}`))
            .children(items.map((p) => this.row(k, p)))
        : null;
    const order = (a, b) => (b.turn?.who === "you") - (a.turn?.who === "you") || b.last_activity - a.last_activity;
    const mine = [...(d?.mine ?? [])].sort(order);
    const theirs = [...(d?.assigned ?? [])].filter((p) => p.turn?.who !== "none").sort(order);
    const sel = list.find((p) => keyOf(p) === this.sel) ?? null;
    const yours = list.filter((p) => p.turn?.who === "you").length;
    return v_flex()
      .id("prs")
      .size_full()
      .bg(k.background)
      .text_color(k.foreground)
      .text_size(TEXT.base)
      .child(
        PageHeader({
          icon: "git-pull-request",
          title: "Pull requests",
          description: "Yours and the ones you review: whose move it is, approvals, reviewers, CI, and an agent to work on them",
          aside: d ? Badge(yours ? `${yours} on you` : "nothing on you", yours ? "warning" : "success") : null,
          actions: [Button("prs-refresh", { label: this.busy === "refresh" ? "Asking…" : "Refresh", icon: "rotate-ccw", variant: "outline", size: "sm", disabled: this.busy === "refresh", onClick: (_e, cx) => this.pull(cx, true) })],
        }),
      )
      .child(
        !d
          ? h_flex().h(160).justify_center().items_center().gap(8).text_color(k.mutedFg).child(Spinner({ size: 14 })).child("Asking GitHub…")
          : d.error && !list.length
            ? Empty({ icon: "git-pull-request", title: "Could not read GitHub", description: d.error })
            : h_flex()
                .flex_1()
                .min_h(0)
                .gap(16)
                .px(24)
                .py(16)
                .child(v_flex().id("prs-list").w(380).flex_none().min_h(0).gap(10).overflow_y_scrollbar().children([group("Your pull requests", mine), group("Waiting for your review", theirs)].filter(Boolean)))
                .child(v_flex().id("prs-detail-scroll").flex_1().min_w(0).min_h(0).overflow_y_scrollbar().child(sel ? this.detail(k, sel, cx) : Empty({ icon: "git-pull-request", title: "Pick a pull request", description: "Its reviewers, CI and an agent to work on it show here." }))),
      );
  }
}
