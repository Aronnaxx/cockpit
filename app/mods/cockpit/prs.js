// The Pull requests tab: yours and the ones you review, each with whose move it is, the approvals it has of what it needs,
// every reviewer with their state, last activity and comments, its CI (the failed jobs, and a button to retry just those),
// how far behind main it is (it is brought up by rebasing, never merging), and a place to start an agent on it: which agent,
// which model, which preset, what task. Nothing is ever posted to GitHub from here. Data: prsdata.js.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { exec, notify, run, shared } from "herdr";
import * as hub from "./hub.js";
import { tokens, alpha, TEXT, RADIUS, Badge, Button, Card, PageHeader, Empty, Mono, Progress, Spinner, TextField, Tabs, Chip, AlertDialog } from "./ui.js";
import { loadPrs, prs, prsConfig, ago } from "./prsdata.js";
import { urgent, urgency } from "./prcards.js";
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
    this.scope = "all";
    this.repoF = null;
    this.ci = new Map();
    this.cfg = {};
    this.busy = null;
    this.agent = lastAgent();
    this.task = null;
    this.model = InputState.new({ placeholder: "search the gateway's models, or type one" });
    // The gateway's models, searched as you type (bin/cockpit-models.py).
    this.models = [];
    this.modelOpen = false;
    this.model.on("focus", (_e, cx) => ((this.modelOpen = true), cx.notify()));
    this.model.on("change", (_e, cx) => ((this.modelOpen = true), cx.notify()));
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-models.py`], { timeout: 30000 });
        this.models = JSON.parse(r.stdout || "{}").models ?? [];
      } catch {}
      cx.notify();
    });
    // Each pull request's conversation (read when it is picked) and the worktrees made this session.
    this.convo = new Map();
    this.openThreads = new Set();
    this.worktrees = new Set();
    this.confirm = null;
    this.trees = [];
    this.loadTrees(cx);
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
    if (!this.convo.has(keyOf(p))) this.readConvo(cx, p);
    const url = p.ci?.builds?.[0];
    if (url && !this.ci.has(url)) {
      this.ci.set(url, "loading");
      this.readCi(cx, url);
    }
    cx.notify();
  }

  readConvo(cx, p) {
    this.convo.set(keyOf(p), "loading");
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-pr-comments.py`, p.repo, String(p.number)], { timeout: 90000 });
        this.convo.set(keyOf(p), JSON.parse(r.stdout || "null") ?? { error: "no answer", items: [] });
      } catch (e) {
        this.convo.set(keyOf(p), { error: String(e?.message ?? e).slice(0, 160), items: [] });
      }
      cx.notify();
    });
  }

  /** Marks the pull request ready for review or back to a draft; closes it. All through gh, after a confirmation for a close. */
  changeState(cx, p, what) {
    cx.spawn(async (cx) => {
      const args = what === "close" ? ["pr", "close", String(p.number), "-R", p.repo] : ["pr", "ready", String(p.number), "-R", p.repo, ...(what === "draft" ? ["--undo"] : [])];
      try {
        await exec("/opt/homebrew/bin/gh", args, { timeout: 60000 });
        notify({ title: what === "close" ? "Pull request closed" : what === "draft" ? "Back to a draft" : "Ready for review", body: keyOf(p) });
      } catch (e) {
        notify({ title: "Could not change the pull request", body: String(e?.message ?? e).slice(0, 160) });
      }
      this.confirm = null;
      await loadPrs({ force: true });
      cx.notify();
    });
  }

  /** Every worktree under ~/worktrees, read again now. */
  loadTrees(cx) {
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-worktree.py`, "--list"], { timeout: 60000 });
        this.trees = JSON.parse(r.stdout || "{}").worktrees ?? [];
      } catch {}
      cx.notify();
    });
  }

  removeTree(cx, t) {
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-worktree.py`, "--remove-path", t.path], { timeout: 120000 });
        const d = JSON.parse(r.stdout || "{}");
        notify(d.error ? { title: "Not removed", body: d.error } : { title: "Worktree removed", body: t.path });
      } catch {}
      this.loadTrees(cx);
    });
  }

  /** The worktrees page: each with its branch, pull request, changes, and buttons to open it in a tab or remove it. */
  treesView(k) {
    const list = this.trees;
    return v_flex()
      .gap(10)
      .child(h_flex().gap(8).items_center().child(div().text_size(TEXT.lg).font_semibold().child(`Worktrees · ${list.length}`)).child(div().flex_1()).child(Button("trees-refresh", { label: "Refresh", icon: "rotate-ccw", variant: "outline", size: "sm", onClick: (_e, cx) => this.loadTrees(cx) })))
      .child(div().text_size(TEXT.sm).text_color(k.mutedFg).child("Checkouts of pull requests under ~/worktrees, made from a pull request's page. Your own branches and checkouts are not touched."))
      .children(
        list.length
          ? list.map((t) =>
              h_flex()
                .id(`tree-${t.name}`)
                .gap(10)
                .items_center()
                .p(12)
                .rounded(RADIUS.lg)
                .border_1()
                .border_color(k.border)
                .bg(k.card)
                .child(v_flex().flex_1().min_w(0).gap(2).child(div().font_medium().truncate().child(t.name)).child(Mono(`${t.branch} · ${t.head}${t.pr ? ` · PR #${t.pr}` : ""}${t.at ? ` · ${ago(t.at)} ago` : ""}`, { size: TEXT.xs, color: k.mutedFg })).child(div().text_size(TEXT.xs).text_color(k.dim).child(t.path)))
                .child(t.dirty ? Badge(`${t.dirty} changed`, "warning") : Badge("clean", "success"))
                .child(Button(`tree-open-${t.name}`, { label: "Open in a tab", icon: "folder", size: "sm", variant: "outline", onClick: () => { run("tab.new", { name: t.name, folder: t.path }); run("layout.select", { stack: "center", child: "work" }); } }))
                .child(Button(`tree-rm-${t.name}`, { label: "Remove", size: "sm", variant: "ghost", onClick: (_e, cx) => this.removeTree(cx, t) })),
            )
          : [Empty({ icon: "git-fork", title: "No worktrees", description: "Open a pull request and pick “Explore in a worktree”." })],
      );
  }

  /** A worktree of the pull request's head (bin/cockpit-worktree.py), opened in a new tab to read and run its code. */
  worktree(cx, p, remove = false) {
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const folder = repoFolder(p.repo, this.cfg).replace(/^~/, home);
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-worktree.py`, p.repo, String(p.number), folder, ...(remove ? ["--remove"] : [])], { timeout: 400000 });
        const d = JSON.parse(r.stdout || "{}");
        if (d.error) return notify({ title: "No worktree", body: d.error });
        if (remove) {
          this.worktrees.delete(keyOf(p));
          notify({ title: "Worktree removed", body: d.removed });
        } else {
          this.worktrees.add(keyOf(p));
          run("tab.new", { name: `${p.repo.split("/")[1]}#${p.number}`, folder: d.path });
          run("layout.select", { stack: "center", child: "work" });
          notify({ title: d.reused ? "Worktree updated" : "Worktree ready", body: d.path });
        }
      } catch (e) {
        notify({ title: "No worktree", body: String(e?.message ?? e).slice(0, 160) });
      }
      this.loadTrees(cx);
      cx.notify();
    });
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
      const ok = await launchAgent({ agent, prompt: prPrompt(kind, { ...p, ci: { failed: this.failedJobs(p) } }), folder: repoFolder(p.repo, this.cfg), name: `${kind} ${p.repo.split("/")[1]}#${p.number}`, model: this.modelValue() });
      if (ok) notify({ title: "Agent started", body: `${LAUNCH_AGENTS.find((a) => a.id === agent)?.label ?? agent} is on ${keyOf(p)}.` });
      cx.notify();
    });
  }

  /** The model typed or picked; OpenCode names a gateway model as litellm/<id>. */
  modelValue() {
    const m = this.model.value().trim();
    if (!m) return null;
    return this.agent === "opencode" && this.models.includes(m) ? `litellm/${m}` : m;
  }

  /** The conversation as GitHub shows it: comments, reviews, and threads on a line with the diff around it. */
  conversation(k, p) {
    const c = this.convo.get(keyOf(p));
    const head = (author, what, at, extra) =>
      h_flex().gap(8).items_center().child(div().size(20).flex_none().rounded(10).flex().items_center().justify_center().bg(alpha(k.info, 0.18)).text_size(10).font_semibold().text_color(k.info).child(author.slice(0, 2).toUpperCase())).child(div().text_size(TEXT.sm).font_semibold().text_color(k.foreground).child(author)).child(div().text_size(TEXT.xs).text_color(k.dim).child(`${what} ${ago(at)} ago`)).child(div().flex_1()).children([extra].filter(Boolean));
    const body = (text) => (text ? div().text_size(TEXT.sm).text_color(k.foreground).whitespace_normal().child(text.length > 1600 ? `${text.slice(0, 1600)}…` : text) : div());
    const chip = (label, color) => div().flex_none().px(6).h(16).flex().items_center().rounded(4).text_size(10).bg(alpha(color, 0.14)).text_color(color).child(label);
    if (!c || c === "loading") return h_flex().gap(8).items_center().text_color(k.mutedFg).child(Spinner({ size: 12 })).child("Reading the conversation…");
    const items = (c.items ?? []).map((it, i) => {
      const id = `cv-${keyOf(p)}-${i}`;
      if (it.kind === "thread") {
        const open = this.openThreads.has(id) ? true : !it.resolved && !this.openThreads.has(`-${id}`);
        return v_flex()
          .id(id)
          .gap(6)
          .p(10)
          .rounded(RADIUS.md)
          .border_1()
          .border_color(k.border)
          .child(
            h_flex().gap(8).items_center().cursor_pointer().on_click((_e, cx) => { open ? (this.openThreads.delete(id), this.openThreads.add(`-${id}`)) : (this.openThreads.add(id), this.openThreads.delete(`-${id}`)); cx.notify(); })
              .child(Mono(`${it.path}${it.line ? `:${it.line}` : ""}`, { size: TEXT.xs, color: k.foreground }))
              .child(div().flex_1())
              .when(it.resolved, (e) => e.child(chip("resolved", k.success)))
              .when(it.outdated, (e) => e.child(chip("outdated", k.warning)))
              .child(div().text_size(TEXT.xs).text_color(k.dim).child(`${it.comments.length} comment${it.comments.length === 1 ? "" : "s"} · ${open ? "hide" : "show"}`)),
          )
          .when(open, (e) =>
            e
              .when(Boolean(it.hunk), (x) => x.child(v_flex().p(6).rounded(RADIUS.sm).bg(alpha(k.muted, 0.7)).children(it.hunk.split("\n").slice(-10).map((l, j) => div().id(`${id}-h${j}`).text_size(10.5).font_family("JetBrains Mono").whitespace_nowrap().text_color(l.startsWith("+") ? k.success : l.startsWith("-") ? k.destructive : k.mutedFg).child(l || " ")))))
              .children(it.comments.map((cm, j) => v_flex().id(`${id}-c${j}`).gap(4).child(head(cm.author, "commented", cm.at)).child(body(cm.body)))),
          );
      }
      return v_flex()
        .id(id)
        .gap(6)
        .p(10)
        .rounded(RADIUS.md)
        .border_1()
        .border_color(it.kind === "review" && it.state === "changes_requested" ? alpha(k.destructive, 0.5) : it.kind === "review" && it.state === "approved" ? alpha(k.success, 0.5) : k.border)
        .child(head(it.author, it.kind === "review" ? "reviewed" : "commented", it.at, it.kind === "review" ? chip(it.state.replace("_", " "), it.state === "approved" ? k.success : it.state === "changes_requested" ? k.destructive : k.mutedFg) : null))
        .child(body(it.body));
    });
    return v_flex().gap(8).children(c.error ? [div().text_size(TEXT.xs).text_color(k.warning).child(c.error)] : items.length ? items : [div().text_size(TEXT.sm).text_color(k.dim).child("No comments yet.")]);
  }

  /** The searchable list under the model field: the gateway's models that match what is typed. */
  modelList(k) {
    if (!this.modelOpen) return null;
    const q = this.model.value().trim().toLowerCase();
    const hits = (q ? this.models.filter((m) => m.toLowerCase().includes(q)) : this.models).slice(0, 60);
    if (!hits.length) return div().text_size(TEXT.xs).text_color(k.dim).child(this.models.length ? "No gateway model matches: it is used as typed." : "The gateway's models could not be read (set litellm.base_url in the config): type one.");
    return v_flex()
      .id("model-list")
      .max_h(200)
      .overflow_y_scrollbar()
      .rounded(RADIUS.md)
      .border_1()
      .border_color(k.border)
      .bg(k.card)
      .p(4)
      .children(hits.map((m) => div().id(`model-${m}`).px(8).h(26).flex().items_center().rounded(RADIUS.sm).cursor_pointer().text_size(TEXT.sm).font_family("JetBrains Mono").text_color(k.foreground).hover((x) => x.bg(k.accent)).on_click((_e, cx) => (this.model.set_value(m), (this.modelOpen = false), cx.notify())).child(m)));
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
    const hot = urgent(p);
    if (hot) return div().flex_none().px(6).h(16).flex().items_center().rounded(4).text_size(9.5).font_semibold().bg(alpha(k[hot.tone], 0.2)).text_color(k[hot.tone]).child(hot.label);
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
          .child(
            h_flex()
              .gap(6)
              .pt(4)
              .child(Button("prs-open", { label: "Open PR", icon: "external", size: "sm", variant: "outline", onClick: (_e, cx) => cx.spawn(async () => hub.openUrl(p.url)) }))
              .child(Button("prs-worktree", { label: this.worktrees.has(keyOf(p)) ? "Open worktree" : "Explore in a worktree", icon: "git-branch", size: "sm", variant: "outline", tooltip: "A git worktree of this pull request's head in ~/worktrees, opened in a new tab; your own checkout is not touched", onClick: (_e, cx) => this.worktree(cx, p) }))
              .when(this.worktrees.has(keyOf(p)), (e) => e.child(Button("prs-worktree-rm", { label: "Remove worktree", size: "sm", variant: "ghost", onClick: (_e, cx) => this.worktree(cx, p, true) })))
              .when(p.role === "author", (e) =>
                e
                  .child(Button("prs-draft", { label: p.draft ? "Mark ready for review" : "Convert to draft", icon: "file-text", size: "sm", variant: "outline", onClick: (_e, cx) => this.changeState(cx, p, p.draft ? "ready" : "draft") }))
                  .child(Button("prs-close", { label: "Close PR", size: "sm", variant: "ghost", onClick: (_e, cx) => ((this.confirm = { p }), cx.notify()) })),
              ),
          ),
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
      .child(section(`Conversation`, this.conversation(k, p)))
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
            div().text_size(TEXT.xs).text_color(k.dim).child(`Model${this.models.length ? ` · ${this.models.length} on the gateway` : ""}`),
            h_flex().gap(6).items_center().child(TextField(this.model)).child(Button("prs-model-toggle", { icon: this.modelOpen ? "chevron-up" : "chevron-down", variant: "outline", size: "icon-sm", tooltip: "The gateway's models", onClick: (_e, cx) => ((this.modelOpen = !this.modelOpen), cx.notify()) })),
            this.modelList(k),
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
    const order = (a, b) => (urgency(b) - urgency(a)) || (b.turn?.who === "you") - (a.turn?.who === "you") || b.last_activity - a.last_activity;
    // Home's "Details" leaves the pull request to open in this shared value.
    const want = shared("cockpit.prs.focus");
    if (want && want !== this.focused) {
      this.focused = want;
      const hit = list.find((p) => keyOf(p) === want);
      if (hit) { this.scope = "all"; this.repoF = null; cx.timer.after(1, (cx) => this.select(cx, hit)); }
    }
    const allMine = [...(d?.mine ?? [])].sort(order);
    const allTheirs = [...(d?.assigned ?? [])].filter((p) => p.turn?.who !== "none").sort(order);
    const repos = [...new Set([...allMine, ...allTheirs].map((p) => p.repo))].sort();
    const inRepo = (p) => !this.repoF || p.repo === this.repoF;
    const mine = this.scope === "review" || this.scope === "trees" ? [] : allMine.filter(inRepo);
    const theirs = this.scope === "mine" || this.scope === "trees" ? [] : allTheirs.filter(inRepo);
    const filters = v_flex()
      .gap(8)
      .child(Tabs("prs-scope", { value: this.scope, onChange: (v, cx) => ((this.scope = v), cx.notify()), items: [{ value: "all", label: "All", count: allMine.length + allTheirs.length }, { value: "mine", label: "Mine", count: allMine.length }, { value: "review", label: "To review", count: allTheirs.length }, { value: "trees", label: "Worktrees", count: this.trees.length }] }))
      .child(h_flex().gap(6).flex_wrap().children([Chip("all repos", { id: "prs-repo-all", color: this.repoF ? undefined : k.ring, onClick: (_e, cx) => ((this.repoF = null), cx.notify()) }), ...repos.map((r) => Chip(r.split("/")[1], { id: `prs-repo-${r}`, color: this.repoF === r ? k.ring : undefined, onClick: (_e, cx) => ((this.repoF = this.repoF === r ? null : r), cx.notify()) }))]));
    const sel = list.find((p) => keyOf(p) === this.sel) ?? null;
    const yours = list.filter((p) => p.turn?.who === "you").length;
    return v_flex()
      .id("prs")
      .relative()
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
                .child(v_flex().id("prs-list").w(380).flex_none().min_h(0).gap(10).overflow_y_scrollbar().children([filters, group("Your pull requests", mine), group("Waiting for your review", theirs)].filter(Boolean)))
                .child(v_flex().id("prs-detail-scroll").flex_1().min_w(0).min_h(0).overflow_y_scrollbar().child(this.scope === "trees" ? this.treesView(k) : sel ? this.detail(k, sel, cx) : Empty({ icon: "git-pull-request", title: "Pick a pull request", description: "Its reviewers, CI and an agent to work on it show here." }))),
      )
      .when(Boolean(this.confirm), (e) =>
        e.child(
          AlertDialog("prs-confirm", {
            title: `Close ${this.confirm.p.repo.split("/")[1]}#${this.confirm.p.number}?`,
            description: `“${this.confirm.p.title}” is closed on GitHub. It can be reopened there.`,
            confirmLabel: "Close pull request",
            destructive: true,
            onCancel: (_e, cx) => ((this.confirm = null), cx.notify()),
            onConfirm: (_e, cx) => this.changeState(cx, this.confirm.p, "close"),
          }),
        ),
      );
  }
}
