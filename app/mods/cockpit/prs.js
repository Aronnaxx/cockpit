// The Pull requests tab: yours and the ones you review, each with whose move it is, the approvals it has of what it needs,
// every reviewer with their state, last activity and comments, its CI (the failed jobs, and a button to retry just those),
// how far behind main it is (it is brought up by rebasing, never merging), and a place to start an agent on it: which agent,
// which model, which preset, what task. Nothing is ever posted to GitHub from here. Data: prsdata.js.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, TextView } from "gpui-base";
import { exec, notify, run, shared, setShared } from "herdr";
import * as hub from "./hub.js";
import { tokens, alpha, TEXT, RADIUS, Badge, Button, Card, PageHeader, Empty, Mono, Progress, Spinner, TextField, Tabs, Chip, AlertDialog, openMenu, Icon } from "./ui.js";
import { loadPrs, prs, prsConfig, ago } from "./prsdata.js";
import { urgent, urgency } from "./prcards.js";
import { Drafts } from "./prreview.js";
import { LAUNCH_AGENTS, launchAgent, lastAgent, prPrompt, repoFolder } from "./agentlaunch.js";
import { OmoModel } from "./agentsui.js";

const keyOf = (p) => `${p.repo}#${p.number}`;
const TASKS = {
  author: [["fix", "Address comments and CI"], ["rebase", "Rebase onto main"]],
  reviewer: [["review", "Review it"], ["rereview", "Re-review (only what changed)"]],
};

// id, app name (macOS), label: what "Open in…" offers when it is installed.
const EDITORS = [["vscode", "Visual Studio Code", "VS Code"], ["zed", "Zed", "Zed"], ["antigravity", "Antigravity", "Antigravity"], ["antigravity-ide", "Antigravity IDE", "Antigravity IDE"], ["cursor", "Cursor", "Cursor"], ["windsurf", "Windsurf", "Windsurf"]];

export default class Prs {
  init(_p, cx) {
    this.sel = null;
    this.scope = "review";
    this.scopeAt = null;
    this.q = InputState.new({ placeholder: "Filter: a repo, a title, a person…" });
    this.q.on("change", (_e, cx) => cx.notify());
    // The editors installed here, for "Open in…".
    this.editors = [];
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", "ls /Applications ~/Applications 2>/dev/null"], { timeout: 10000 });
        const have = new Set(String(r.stdout).split("\n").map((n) => n.replace(/\.app$/, "")));
        this.editors = EDITORS.filter(([, app]) => have.has(app));
      } catch {}
      cx.notify();
    });
    this.repoF = null;
    this.authorF = null;
    this.reviewF = "all";
    this.sort = "needs";
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
    this.drafts = new Drafts();
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
    // An agent writes the review draft while you look: read again every few seconds.
    cx.timer.every(3000, (cx) => {
      const p = this.list().find((x) => keyOf(x) === this.sel);
      if (p) this.drafts.load(cx, p).then((c) => c && cx.notify());
    });
  }

  command(c, cx) {
    // From a menu: prs:<kind>:<agent>:<owner/name#number>
    const m = c.match(/^prs:([a-z]+):([a-z-]+):(.+)$/);
    if (!m) return;
    if (m[1] === "filter") {
      const v = m[3] === "__all" ? null : m[3];
      if (m[2] === "author") this.authorF = v;
      else if (m[2] === "repo") this.repoF = v;
      else if (m[2] === "review") this.reviewF = v ?? "all";
      else if (m[2] === "sort") this.sort = v ?? "needs";
      return cx.notify();
    }
    const p = this.list().find((x) => keyOf(x) === m[3]);
    if (p && m[1] === "openin") this.openIn(cx, p, m[2]);
    else if (p) this.start(cx, p, m[1], m[2]);
  }

  list() {
    const d = prs();
    return [...(d?.mine ?? []), ...(d?.assigned ?? [])];
  }

  select(cx, p) {
    this.sel = keyOf(p);
    this.task = null;
    if (!this.convo.has(keyOf(p))) this.readConvo(cx, p);
    this.drafts.load(cx, p).then((c) => c && cx.notify());
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
      cx.notify();
    });
  }

  /** The pull request's worktree (made or brought up to date), opened in an editor. */
  openIn(cx, p, id) {
    const app = EDITORS.find(([e]) => e === id)?.[1];
    if (!app) return;
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const folder = repoFolder(p.repo, this.cfg).replace(/^~/, home);
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-worktree.py`, p.repo, String(p.number), folder], { timeout: 400000 });
        const d = JSON.parse(r.stdout || "{}");
        if (d.error) return notify({ title: "No worktree", body: d.error });
        this.worktrees.add(keyOf(p));
        await exec("open", ["-a", app, d.path], { timeout: 20000 });
        notify({ title: `Opened in ${app}`, body: d.path });
      } catch (e) {
        notify({ title: "Could not open it", body: String(e?.message ?? e).slice(0, 160) });
      }
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
    let mdn = 0;
    const body = (text) => (text ? TextView.markdown(`cv-md-${keyOf(p)}-${++mdn}`, text.length > 1600 ? `${text.slice(0, 1600)}…` : text).selectable(true).w_full() : div());
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
              .child(div().text_size(TEXT.xs).text_color(k.dim).child(`${it.comments.length} comment${it.comments.length === 1 ? "" : "s"} · ${open ? "hide" : "show"}`))
              .when(Boolean(it.reply_id), (x) => x.child(Button(`rv-reply-${id}`, { label: "Reply", size: "sm", variant: "ghost", onClick: (_e, cx) => { cx.stop_propagation(); this.drafts.addComment(cx, p, { reply_to: it.reply_id, quote: `${it.path}:${it.line ?? ""} · ${it.author}: ${(it.comments?.[0]?.body ?? "").slice(0, 80)}` }); } }))),
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

  /** One pull request in the list, as GitHub lists them: a state icon, the title with its flags, then #number, repository, author, when, approvals, CI. */
  row(k, p) {
    const hot = urgent(p);
    const c = hot ? k[hot.tone] : this.turnColor(k, p.turn);
    const unresolved = p.unresolved ?? 0;
    return h_flex()
      .id(`pr-${keyOf(p)}`)
      .gap(12)
      .items_start()
      .px(14)
      .py(10)
      .border_b_1()
      .border_color(k.border)
      .cursor_pointer()
      .hover((x) => x.bg(k.accent))
      .on_click((_e, cx) => this.select(cx, p))
      .child(div().pt(2).child(Icon(p.draft ? "git-pull-request-draft" : "git-pull-request", { size: 16, color: p.draft ? k.mutedFg : c })))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(h_flex().gap(8).items_center().child(div().truncate().font_semibold().text_size(TEXT.base).text_color(k.foreground).child(p.title)).when(Boolean(this.pill(k, p)), (e) => e.child(this.pill(k, p))).when(p.draft, (e) => e.child(Badge("draft", "secondary"))))
          .child(
            h_flex()
              .gap(8)
              .flex_wrap()
              .text_size(TEXT.xs)
              .text_color(k.dim)
              .child(Mono(`#${p.number}`, { size: TEXT.xs, color: k.mutedFg }))
              .child(div().child(p.repo.split("/")[1]))
              .child(div().child(`${p.author} · active ${ago(p.last_activity)}`))
              .child(Mono(`${p.approvals}/${p.required}`, { size: TEXT.xs, color: p.approvals >= p.required ? k.success : k.mutedFg }))
              .child(div().text_color(p.ci.failed.length ? k.destructive : p.ci.pending ? k.warning : k.success).child(p.ci.failed.length ? `CI: ${p.ci.failed.length} failed` : p.ci.pending ? "CI running" : p.ci.state === "none" ? "" : "CI passing"))
              .when(unresolved > 0, (e) => e.child(div().text_color(k.warning).child(`${unresolved} unresolved`)))
              .when(p.role === "author" && (p.behind ?? 0) > 0, (e) => e.child(div().text_color(k.warning).child(`${p.behind} behind main`))),
          ),
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
              .when(this.editors.length > 0, (e) => e.child(Button("prs-openin", { label: "Open in…", icon: "folder", size: "sm", variant: "outline", tooltip: "The pull request's worktree, in an editor", onClick: () => openMenu(this.editors.map(([id, , label]) => ({ label, icon: "code", command: `prs:openin:${id}:${keyOf(p)}` })), { width: 200 }) })))
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
      .child(this.drafts.section(k, p, { agentButton: Button("rv-agent", { label: p.role === "author" ? "Draft replies with an agent…" : "Draft a review with an agent…", icon: "bot", size: "sm", variant: "outline", tooltip: "An agent reads the PR and writes a draft here. Nothing is posted.", onClick: () => openMenu(LAUNCH_AGENTS.map((a) => ({ label: a.label, icon: "bot", command: `prs:${p.role === "author" ? "fix" : p.turn?.why === "re-review" ? "rereview" : "review"}:${a.id}:${keyOf(p)}` })), { width: 220 }) }) }))
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
    const order = (a, b) => (urgency(b) - urgency(a)) || (b.turn?.who === "you") - (a.turn?.who === "you") || b.last_activity - a.last_activity;
    // Home's "Details" leaves the pull request to open in this shared value.
    const sc = shared("cockpit.prs.scope");
    if (sc && sc.at !== this.scopeAt) {
      this.scopeAt = sc.at;
      this.scope = sc.scope;
      this.repoF = null;
    }
    const want = shared("cockpit.prs.focus");
    if (!want) this.focused = null;
    if (want && want !== this.focused) {
      this.focused = want;
      const hit = list.find((p) => keyOf(p) === want);
      if (hit) { this.scope = "mine"; this.repoF = null; cx.timer.after(1, (cx) => this.select(cx, hit)); }
    }
    const all = this.scope === "mine" ? d?.mine ?? [] : (d?.assigned ?? []).filter((p) => p.turn?.who !== "none");
    const inScope = { mine: d?.mine ?? [], review: (d?.assigned ?? []).filter((p) => p.turn?.who !== "none") };
    const repos = [...new Set(all.map((p) => p.repo))].sort();
    const authors = [...new Set(all.map((p) => p.author))].sort((a, b) => a.localeCompare(b));
    const needle = this.q.value().trim().toLowerCase();
    const matches = (p) => !needle || `${p.repo} ${p.number} ${p.title} ${p.branch} ${p.author} ${(p.reviewers ?? []).map((r) => r.login).join(" ")}`.toLowerCase().includes(needle);
    const reviewOk = (p) =>
      this.reviewF === "all" ||
      (this.reviewF === "you" && p.turn?.who === "you") ||
      (this.reviewF === "rerequested" && (p.turn?.why === "re-requested" || p.turn?.why === "re-review")) ||
      (this.reviewF === "approved" && p.decision === "APPROVED") ||
      (this.reviewF === "changes" && p.decision === "CHANGES_REQUESTED") ||
      (this.reviewF === "draft" && p.draft) ||
      (this.reviewF === "ci" && p.ci.failed.length > 0);
    const sorters = {
      needs: (a, b) => (urgency(b) - urgency(a)) || (b.turn?.who === "you") - (a.turn?.who === "you") || b.last_activity - a.last_activity,
      updated: (a, b) => b.last_activity - a.last_activity,
      stale: (a, b) => a.last_activity - b.last_activity,
      threads: (a, b) => (b.unresolved ?? 0) - (a.unresolved ?? 0) || b.last_activity - a.last_activity,
    };
    const shownList = all.filter((p) => (!this.repoF || p.repo === this.repoF) && (!this.authorF || p.author === this.authorF) && reviewOk(p) && matches(p)).sort(sorters[this.sort]);
    const youN = all.filter((p) => p.turn?.who === "you").length;
    const summary = this.scope === "mine" ? `${youN} on you · ${all.length - youN} waiting` : `${youN} for you · ${all.length - youN} team`;
    const dd = (id, label, items) =>
      h_flex().id(id).h(28).px(8).gap(4).items_center().rounded(RADIUS.md).cursor_pointer().text_size(TEXT.sm).text_color(k.mutedFg).hover((x) => x.bg(k.accent).text_color(k.foreground)).on_click(() => openMenu(items, { width: 240 })).child(div().child(label)).child(Icon("chevron-down", { size: 12 }));
    const pick = (kind, value, label, on) => ({ label, icon: on ? "check" : undefined, command: `prs:filter:${kind}:${value ?? "__all"}` });
    const REVIEWS = [["all", "Any state"], ["you", "Needs you"], ["rerequested", "Re-review requested"], ["approved", "Approved"], ["changes", "Changes requested"], ["draft", "Drafts"], ["ci", "CI failing"]];
    const SORTS = [["needs", "Needs you first"], ["updated", "Recently updated"], ["stale", "Least recently updated"], ["threads", "Most unresolved threads"]];
    const filtering = this.repoF || this.authorF || this.reviewF !== "all" || needle;
    const bar = v_flex()
      .gap(8)
      .child(TextField(this.q, { active: false, leading: Icon("search", { size: 14, color: k.mutedFg }) }))
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .h(44)
          .px(10)
          .rounded_t(RADIUS.lg)
          .border_1()
          .border_color(k.border)
          .bg(k.muted)
          .child(Tabs("prs-scope", { value: this.scope, onChange: (v, cx) => ((this.scope = v), (this.repoF = null), (this.authorF = null), cx.notify()), items: [{ value: "review", label: "To review", count: inScope.review.length }, { value: "mine", label: "Yours", count: inScope.mine.length }] }))
          .child(div().pl(8).text_size(TEXT.xs).text_color(k.dim).child(summary))
          .child(div().flex_1())
          .child(dd("prs-dd-author", this.authorF ? `Author: ${this.authorF}` : "Author", [pick("author", null, "Anyone", !this.authorF), ...authors.map((a) => pick("author", a, a, this.authorF === a))]))
          .child(dd("prs-dd-repo", this.repoF ? `Repository: ${this.repoF.split("/")[1]}` : "Repository", [pick("repo", null, "All repositories", !this.repoF), ...repos.map((r) => pick("repo", r, r.split("/")[1], this.repoF === r))]))
          .child(dd("prs-dd-review", this.reviewF === "all" ? "Reviews" : `Reviews: ${REVIEWS.find(([v]) => v === this.reviewF)?.[1]}`, REVIEWS.map(([v, l]) => pick("review", v, l, this.reviewF === v))))
          .child(dd("prs-dd-sort", SORTS.find(([v]) => v === this.sort)?.[1], SORTS.map(([v, l]) => pick("sort", v, l, this.sort === v))))
          .when(Boolean(filtering), (e) => e.child(Button("prs-clear", { label: "Clear", variant: "ghost", size: "sm", onClick: (_e, cx) => { this.repoF = null; this.authorF = null; this.reviewF = "all"; this.q.set_value(""); cx.notify(); } }))),
      );
    const listView = v_flex()
      .id("prs-list")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .gap(0)
      .px(24)
      .py(16)
      .child(bar)
      .child(v_flex().border_x_1().border_b_1().border_color(k.border).rounded_b(RADIUS.lg).children(shownList.length ? shownList.map((p) => this.row(k, p)) : [h_flex().h(120).justify_center().items_center().text_color(k.mutedFg).child("No pull requests match.")]));
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
            : sel
              ? v_flex()
                  .id("prs-detail-scroll")
                  .flex_1()
                  .min_h(0)
                  .overflow_y_scrollbar()
                  .px(24)
                  .py(16)
                  .gap(12)
                  .child(h_flex().child(Button("prs-back", { label: "Pull requests", icon: "chevron-left", variant: "ghost", size: "sm", onClick: (_e, cx) => ((this.sel = null), setShared("cockpit.prs.focus", null), cx.notify()) })))
                  .child(this.detail(k, sel, cx))
              : listView,
      )
      .when(Boolean(this.drafts.confirm), (e) => {
        const dp = this.drafts.confirm.p;
        const de = this.drafts.m.get(keyOf(dp));
        const n = de?.exists ? this.drafts.counts(de) : { lines: 0, replies: 0 };
        const verb = de?.verdict === "APPROVE" ? "an approval" : de?.verdict === "REQUEST_CHANGES" ? "a request for changes" : "a review";
        return e.child(
          AlertDialog("prs-post", {
            title: `Post ${verb} on ${dp.repo.split("/")[1]}#${dp.number}?`,
            description: `${n.lines} line comment${n.lines === 1 ? "" : "s"} and ${n.replies} repl${n.replies === 1 ? "y" : "ies"} go to GitHub under your name, visible to everyone on the pull request.`,
            confirmLabel: "Post review",
            onCancel: (_e, cx) => ((this.drafts.confirm = null), cx.notify()),
            onConfirm: (_e, cx) => this.drafts.post(cx, dp, (cx) => this.readConvo(cx, dp)),
          }),
        );
      })
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
