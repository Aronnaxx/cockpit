// The Pull requests tab: yours and the ones you review, each with whose move it is, the approvals it has of what it needs,
// every reviewer with their state, last activity and comments, its CI (the failed jobs, and a button to retry just those),
// how far behind main it is (it is brought up by rebasing, never merging), and a place to start an agent on it: which agent,
// which model, which preset, what task. Nothing is ever posted to GitHub from here. Data: prsdata.js.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, TextView } from "gpui-base";
import { exec, notify, run, shared, setShared, agents, readTextFile, writeTextFile } from "herdr";
import * as hub from "./hub.js";
import { tokens, alpha, TEXT, RADIUS, Badge, Button, Card, PageHeader, Empty, Mono, Progress, Spinner, TextField, Tabs, Chip, AlertDialog, openMenu, Icon } from "./ui.js";
import { loadPrs, prs, prsConfig, ago } from "./prsdata.js";
import { urgent, urgency, reviewOf } from "./prcards.js";
import { ModelPicker } from "./modelpick.js";
import { Drafts } from "./prreview.js";
import { PrFiles, parsePatch } from "./prfiles.js";
import { installedEditors, openInEditor } from "./editors.js";
import { CodeRows } from "./codeblock.js";
import { flowGraph, laidOut, Graph, graphSize, fit } from "./diagram.js";
import { openInSpace, prWorktree, LAUNCH_AGENTS, launchAgent, lastAgent, prPrompt, repoFolder } from "./agentlaunch.js";
import { OmoModel } from "./agentsui.js";

const keyOf = (p) => `${p.repo}#${p.number}`;
const TASKS = {
  author: [["fix", "Address comments and CI"], ["rebase", "Rebase onto main"]],
  reviewer: [["review", "Review it"], ["rereview", "Re-review (only what changed)"]],
};

export default class Prs {
  init(_p, cx) {
    this.sel = null;
    // As a pane beside an agent (beside.js): one pull request, opened once the list is read; no page header.
    this.docked = _p?.docked ? _p.pr ?? null : null;
    this.scope = "review";
    this.scopeAt = null;
    this.q = InputState.new({ placeholder: "Filter: a repo, a title, a person…" });
    this.q.on("change", (_e, cx) => cx.notify());
    // The editors installed here, for "Open in…".
    this.editors = [];
    installedEditors().then((e) => ((this.editors = e), cx.notify()));
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
    this.merge = new Map();
    this.rebaseAsk = null;
    this.drafts = new Drafts();
    this.pfiles = new PrFiles();
    this.view = null;
    // The model that explains a pull request and why a comment was made: any of the gateway's, remembered.
    this.explainModel = new ModelPicker(cx, { placeholder: "Search the gateway's models", store: "cockpit.explain.model" });
    this.drafts.modelOf = () => this.explainModel.value();
    this.jobs = new Map(); // "explain:<key>" | "quiz:<key>" -> {kind, p, model, at}: running in the background
    cx.timer.every(3000, (cx) => this.pollJobs(cx));
    cx.timer.every(30000, (cx) => this.autoJobs(cx));
    this.quiz = new Map(); // key -> the quiz (bin/cockpit-explain.py quiz) with your answers | "loading" | {error}
    this.explain = new Map(); // key -> the explanation (bin/cockpit-explain.py) | "loading" | {error}
    // The review drafts on disk (what "In progress" lists with the agents working on a PR): key -> {comments, verdict}.
    this.draftInfo = new Map();
    this.readDrafts(cx);
    cx.timer.every(10000, (cx) => this.readDrafts(cx));
    this.omo = new OmoModel();
    this.omo.follow(cx);
    const pull = (cx, force) =>
      cx.spawn(async (cx) => {
        this.busy = force ? "refresh" : this.busy;
        cx.notify();
        await loadPrs({ force });
        this.cfg = await prsConfig();
        if (!this.explainModel.value()) this.explainModel.input.set_value(this.jobModel());
        this.busy = null;
        if (this.docked && !this.dockedOpen) {
          const hit = this.list().find((x) => keyOf(x) === this.docked);
          if (hit) {
            this.dockedOpen = true;
            this.select(cx, hit);
          }
        }
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

  /** Which pull requests have a review draft, and how big it is. */
  readDrafts(cx) {
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const dir = `${home}/.cache/cockpit/review-drafts`;
        const r = await exec("ls", [dir]);
        const next = new Map();
        for (const name of r.stdout.split("\n")) {
          const m = name.match(/^(.+?)__(.+)__(\d+)\.json$/);
          if (!m) continue;
          try {
            const d = JSON.parse((await readTextFile(`${dir}/${name}`)) ?? "{}");
            const n = (d.comments ?? []).filter((c) => String(c.body ?? "").trim()).length;
            if (n || String(d.summary ?? "").trim()) next.set(`${m[1]}/${m[2]}#${m[3]}`, { comments: n, verdict: d.verdict });
          } catch {}
        }
        if (JSON.stringify([...next]) !== JSON.stringify([...this.draftInfo])) {
          this.draftInfo = next;
          cx.notify();
        }
      } catch {}
    });
  }

  /** The agents working on each pull request now (their tab is named "review mono#1937", "fix …"): key -> [agent]. */
  agentsOn() {
    const out = new Map();
    for (const a of agents()) {
      const p = reviewOf(a.tab_name);
      if (p) out.set(keyOf(p), [...(out.get(keyOf(p)) ?? []), a]);
    }
    return out;
  }

  /** The explanation written earlier for this pull request, if any. */
  loadExplain(cx, p) {
    if (this.explain.has(keyOf(p))) return;
    cx.spawn(async (cx) => {
      const { home } = await hub.install();
      // Still being written (a job this page or another started): followed until its marker goes.
      const base = `${home}/.cache/cockpit/explain/${p.repo.replace("/", "__")}__${p.number}.json`;
      const running = await readTextFile(`${base}.running`).catch(() => null);
      if (running !== null) {
        this.explain.set(keyOf(p), "loading");
        this.jobs.set(`explain:${keyOf(p)}`, { kind: "explain", p, model: JSON.parse(running || "{}").model, at: 0 });
        return cx.notify();
      }
      const text = await readTextFile(`${home}/.cache/cockpit/explain/${p.repo.replace("/", "__")}__${p.number}.json`).catch(() => null);
      if (text && !this.explain.has(keyOf(p))) {
        try {
          const d = JSON.parse(text);
          this.explain.set(keyOf(p), d);
          // One the reviewing agent wrote (the cockpit-pr-review skill) has no line counts yet: counted from the diff.
          if (d.files == null || !d.head) {
            cx.notify();
            const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-explain.py`, "fill", p.repo, String(p.number)], { timeout: 180000 });
            const filled = JSON.parse(r.stdout || "{}");
            if (!filled.error) this.explain.set(keyOf(p), filled);
          }
        } catch {}
      }
      cx.notify();
    });
  }

  /** The explaining model: the one picked, else explain.model in the cockpit config (Gemini Flash: cheap enough to run unasked). */
  jobModel() {
    return this.explainModel.value() || this.cfg?.explain?.model || "agy/gemini-3.8-flash-medium";
  }

  /** An explanation or a quiz (bin/cockpit-explain.py), detached: it keeps going when you leave the page, and any copy of the page
   *  sees it through its marker file. */
  startJob(cx, kind, p, model = this.jobModel()) {
    const map = kind === "quiz" ? this.quiz : this.explain;
    map.set(keyOf(p), "loading");
    this.jobs.set(`${kind}:${keyOf(p)}`, { kind, p, model, at: Date.now() });
    cx.notify();
    cx.spawn(async () => {
      const { home } = await hub.install();
      const q = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;
      await exec("sh", ["-c", `nohup python3 ${q(`${home}/.local/share/cockpit/herdr/helpers/cockpit-explain.py`)} ${kind === "quiz" ? "quiz" : "pr"} ${q(p.repo)} ${p.number} ${q(model)} >/dev/null 2>&1 &`]).catch(() => {});
    });
  }

  /** Jobs still running: done when their marker is gone (the result, or the error, is then read). */
  pollJobs(cx) {
    if (!this.jobs.size) return;
    cx.spawn(async (cx) => {
      const { home } = await hub.install();
      for (const [id, j] of [...this.jobs]) {
        if (Date.now() - j.at < 2500) continue;
        const base = `${home}/.cache/cockpit/${j.kind === "quiz" ? "quiz" : "explain"}/${j.p.repo.replace("/", "__")}__${j.p.number}.json`;
        if ((await readTextFile(`${base}.running`).catch(() => null)) !== null) continue;
        const map = j.kind === "quiz" ? this.quiz : this.explain;
        const err = await readTextFile(`${base}.error`).catch(() => null);
        const text = await readTextFile(base).catch(() => null);
        try {
          const e = err ? JSON.parse(err) : null;
          const d = text ? JSON.parse(text) : null;
          if (e && (!d || e.at > (d.at ?? 0))) map.set(keyOf(j.p), { error: e.error });
          else if (d) {
            map.set(keyOf(j.p), d);
            if (j.kind === "quiz") for (const q of d.questions ?? []) if (q.path) this.drafts.ensureFile(cx, j.p, q.path);
          } else map.set(keyOf(j.p), { error: "it stopped without an answer" });
        } catch {
          map.set(keyOf(j.p), { error: "its answer could not be read" });
        }
        this.jobs.delete(id);
        cx.notify();
      }
    });
  }

  /** Without being asked: an explanation for the pull request you open, and an explanation and a quiz for every one with a
   *  review draft whose agent has finished (explain.auto in the cockpit config, on unless false). Two at a time. */
  autoJobs(cx, opened = null) {
    if (this.docked || this.cfg?.explain?.auto === false) return;
    cx.spawn(async (cx) => {
      const { home } = await hub.install();
      const have = async (dir) => new Set(((await exec("ls", [`${home}/.cache/cockpit/${dir}`]).catch(() => ({ stdout: "" }))).stdout ?? "").split("\n"));
      const [ex, qz] = [await have("explain"), await have("quiz")];
      const name = (p) => `${p.repo.replace("/", "__")}__${p.number}.json`;
      const busy = () => this.jobs.size >= 2;
      const working = this.agentsOn();
      const want = [];
      if (opened) want.push(["explain", opened]);
      for (const p of this.list()) {
        const d = this.draftInfo.get(keyOf(p));
        if (!d?.comments || (working.get(keyOf(p)) ?? []).some((a) => a.status === "working")) continue;
        want.push(["explain", p], ["quiz", p]);
      }
      for (const [kind, p] of want) {
        if (busy()) break;
        const set = kind === "quiz" ? qz : ex;
        const map = kind === "quiz" ? this.quiz : this.explain;
        if (set.has(name(p)) || set.has(`${name(p)}.running`) || set.has(`${name(p)}.error`) || this.jobs.has(`${kind}:${keyOf(p)}`) || map.get(keyOf(p)) === "loading") continue;
        this.startJob(cx, kind, p);
      }
    });
  }

  list() {
    const d = prs();
    return [...(d?.mine ?? []), ...(d?.assigned ?? [])];
  }

  select(cx, p) {
    this.sel = keyOf(p);
    this.view = null;
    this.task = null;
    if (!this.convo.has(keyOf(p))) this.readConvo(cx, p);
    this.drafts.load(cx, p).then((c) => c && cx.notify());
    this.loadQuiz(cx, p);
    this.autoJobs(cx, p);
    if (p.role === "author" && (p.behind ?? 0) > 0) this.checkMerge(cx, p);
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
        const d = JSON.parse(r.stdout || "null") ?? { error: "no answer", items: [] };
        // The diff around each line comment, in the file's language: +/- in a gutter, the code highlighted.
        for (const it of d.items ?? []) {
          if (it.kind !== "thread" || !it.hunk) continue;
          it.rows = parsePatch(it.hunk).flatMap((h) => h.rows).slice(-10).map((r) => ({ num: r.new, old: r.old, t: r.t, text: r.text }));
        }
        this.convo.set(keyOf(p), d);
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
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-worktree.py`, p.repo, String(p.number), folder, ...(remove ? ["--remove"] : p.cross ? [] : ["--branch", p.branch])], { timeout: 400000 });
        const d = JSON.parse(r.stdout || "{}");
        if (d.error) return notify({ title: "No worktree", body: d.error });
        if (remove) {
          this.worktrees.delete(keyOf(p));
          notify({ title: "Worktree removed", body: d.removed });
        } else {
          this.worktrees.add(keyOf(p));
          openInSpace(p.repo.split("/")[1], { name: `${p.repo.split("/")[1]}#${p.number}`, folder: d.path });
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
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const folder = repoFolder(p.repo, this.cfg).replace(/^~/, home);
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-worktree.py`, p.repo, String(p.number), folder, ...(p.cross ? [] : ["--branch", p.branch])], { timeout: 400000 });
        const d = JSON.parse(r.stdout || "{}");
        if (d.error) return notify({ title: "No worktree", body: d.error });
        this.worktrees.add(keyOf(p));
        await openInEditor(id, d.path);
      } catch (e) {
        notify({ title: "Could not open it", body: String(e?.message ?? e).slice(0, 160) });
      }
      cx.notify();
    });
  }

  /** Would a rebase onto main go through? Tried in a throwaway worktree; the files in conflict when it would not. */
  checkMerge(cx, p, force = false) {
    if (!force && this.merge.has(keyOf(p))) return;
    this.merge.set(keyOf(p), "loading");
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const folder = repoFolder(p.repo, this.cfg).replace(/^~/, home);
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-rebase.py`, p.repo, String(p.number), folder, p.branch, p.head], { timeout: 600000 });
        this.merge.set(keyOf(p), JSON.parse(r.stdout || "{}"));
      } catch (e) {
        this.merge.set(keyOf(p), { error: String(e?.message ?? e).slice(0, 160) });
      }
      cx.notify();
    });
  }

  /** Rebases and force-pushes the branch (after the confirmation), when the check said it is clean. */
  rebaseNow(cx, p) {
    cx.spawn(async (cx) => {
      this.merge.set(keyOf(p), "loading");
      this.rebaseAsk = null;
      cx.notify();
      try {
        const { home } = await hub.install();
        const folder = repoFolder(p.repo, this.cfg).replace(/^~/, home);
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-rebase.py`, p.repo, String(p.number), folder, p.branch, p.head, "--push"], { timeout: 600000 });
        const d = JSON.parse(r.stdout || "{}");
        if (d.pushed) notify({ title: "Rebased and pushed", body: `${keyOf(p)} is on top of ${p.base} now` });
        else notify({ title: "Not rebased", body: d.error ?? `Conflicts in ${(d.files ?? []).join(", ")}` });
        this.merge.delete(keyOf(p));
        await loadPrs({ force: true });
        const fresh = this.list().find((x) => keyOf(x) === keyOf(p));
        if (fresh && (fresh.behind ?? 0) > 0) this.checkMerge(cx, fresh, true);
      } catch (e) {
        notify({ title: "Not rebased", body: String(e?.message ?? e).slice(0, 160) });
        this.merge.delete(keyOf(p));
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
      const ok = await launchAgent({ agent, prompt: prPrompt(kind, { ...p, ci: { failed: this.failedJobs(p) }, conflicts: this.merge.get(keyOf(p))?.files }), folder: await prWorktree(p, this.cfg), name: `${kind} ${p.repo.split("/")[1]}#${p.number}`, model: this.modelValue() });
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
              .when(Boolean(it.rows?.length), (x) => x.child(CodeRows(`${id}-code`, it.rows, it.path)))
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
  row(k, p, working = null) {
    const hot = urgent(p);
    const draft = this.draftInfo.get(keyOf(p));
    const chip = (label, color) => div().flex_none().px(6).h(16).flex().items_center().rounded(4).text_size(9.5).font_semibold().bg(alpha(color, 0.16)).text_color(color).child(label);
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
          .child(h_flex().gap(8).items_center().child(div().truncate().font_semibold().text_size(TEXT.base).text_color(k.foreground).child(p.title)).when(Boolean(this.pill(k, p)), (e) => e.child(this.pill(k, p))).when(p.draft, (e) => e.child(Badge("draft", "secondary"))).when(Boolean(working?.length), (e) => e.child(chip(working.some((a) => a.status === "working") ? "AGENT WORKING" : "AGENT DONE", k.info))).when(Boolean(draft), (e) => e.child(chip(`REVIEW DRAFT · ${draft.comments}`, k.warning))))
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

  /** What a rebase onto main would do, and the buttons for it: rebase now, or hand the conflicts to an agent. */
  mergeBlock(k, p) {
    if (p.role !== "author" || (p.behind ?? 0) <= 0) return [];
    const m = this.merge.get(keyOf(p));
    const agent = (label, kind) => Button(`prs-${kind}`, { label, icon: "bot", size: "sm", variant: kind === "conflicts" ? "default" : "outline", onClick: (_e, cx) => this.start(cx, p, kind) });
    if (!m || m === "loading") return [h_flex().gap(8).items_center().text_color(k.mutedFg).text_size(TEXT.sm).child(Spinner({ size: 12 })).child("Trying the rebase in a scratch worktree…")];
    if (m.error) return [div().text_size(TEXT.sm).text_color(k.warning).child(m.error), h_flex().gap(8).child(agent("Rebase onto main with an agent", "rebase")).child(Button("prs-recheck", { label: "Check again", size: "sm", variant: "ghost", onClick: (_e, cx) => this.checkMerge(cx, p, true) }))];
    if (m.clean)
      return [
        div().text_size(TEXT.sm).text_color(k.success).child("It rebases onto main cleanly."),
        h_flex().gap(8).child(Button("prs-rebase-now", { label: "Rebase now…", icon: "git-branch", size: "sm", onClick: (_e, cx) => ((this.rebaseAsk = p), cx.notify()) })).child(agent("Rebase with an agent", "rebase")),
      ];
    return [
      div().text_size(TEXT.sm).font_semibold().text_color(k.destructive).child(`Conflicts with ${p.base} in ${m.files.length} file${m.files.length === 1 ? "" : "s"}`),
      v_flex().gap(2).p(8).rounded(RADIUS.md).bg(alpha(k.destructive, 0.08)).children(m.files.map((f) => div().id(`cf-${f}`).text_size(TEXT.xs).font_family("JetBrains Mono").text_color(k.foreground).child(f))),
      h_flex().gap(8).child(agent("Resolve conflicts with an agent", "conflicts")).child(Button("prs-recheck", { label: "Check again", size: "sm", variant: "ghost", onClick: (_e, cx) => this.checkMerge(cx, p, true) })),
    ];
  }

  /** The explanation's flowchart, laid out and drawn as the show view draws one (diagram.js), fitted to the page; text art when an
   * older explanation has that instead. */
  explainDiagram(k, p, dg) {
    if (!dg.nodes?.length) return v_flex().p(12).rounded(RADIUS.md).bg(alpha(k.muted, 0.7)).children(String(dg.art ?? "").split("\n").map((l, i) => div().id(`ex-dg-${i}`).whitespace_nowrap().text_size(11.5).font_family("JetBrains Mono").text_color(l.includes("*") ? k.foreground : k.mutedFg).child(l || " ")));
    const g = flowGraph({ direction: dg.direction === "right" ? "right" : "down", nodes: dg.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind === "box" ? null : n.kind, status: n.changed ? "active" : null })), edges: dg.edges.map((e) => ({ ...e, label: e.label || null })) });
    const L = laidOut(`explain:${keyOf(p)}:${JSON.stringify(dg.nodes)}:${JSON.stringify(dg.edges)}`, g);
    const room = Math.max(320, (this.width ?? 1100) - 120);
    return h_flex().w_full().justify_center().child(Graph(`ex-graph-${keyOf(p)}`, L, { scale: Math.min(1.2, fit(graphSize(L).w, room, 0.4)), hovered: this.exHover ?? null, onHover: (id, cx) => { if (this.exHover !== id) { this.exHover = id; cx.notify(); } } }));
  }

  /** Explain: what the pull request does and how it differs from its base, written by a gateway model and kept per head. */
  explainPage(k, p) {
    const x = this.explain.get(keyOf(p));
    const card = (id, title, ...kids) => v_flex().id(id).gap(10).p(14).rounded(RADIUS.lg).border_1().border_color(k.border).bg(k.card).child(div().text_size(TEXT.sm).font_semibold().text_color(k.foreground).child(title)).children(kids.filter(Boolean));
    const ready = x && x !== "loading" && !x.error;
    const head = v_flex().gap(10).p(14).rounded(RADIUS.lg).border_1().border_color(k.border).bg(k.card)
      .child(h_flex().gap(8).items_center().child(Icon("sparkles", { size: 16, color: k.ring })).child(div().text_size(TEXT.base).font_semibold().child("Explain this pull request")).child(div().flex_1())
        .when(ready && x.head !== p.head, (e) => e.child(Badge("written for an older head", "warning")))
        .when(ready, (e) => e.child(div().text_size(TEXT.xs).text_color(k.dim).child(`${x.by_agent ? "written while reviewing by " : ""}${x.model ?? "?"}${x.at ? ` · ${ago(x.at)} ago` : ""}`))))
      .child(div().text_size(TEXT.xs).text_color(k.mutedFg).child("A model of the gateway reads the description and the whole diff against the base, and explains it: it does not judge it. The lines changed per area are counted from the diff."))
      .child(h_flex().gap(8).items_start().child(div().flex_1().min_w(0).child(this.explainModel.element(k, "explain"))).child(Button("prs-explain-go", { label: x === "loading" ? "Explaining…" : ready ? "Explain again" : "Explain", icon: "sparkles", size: "sm", disabled: x === "loading" || !this.explainModel.value(), tooltip: this.explainModel.value() ? undefined : "Pick a model first", onClick: (_e, cx) => this.writeExplain(cx, p) })));
    if (!x) return v_flex().gap(12).child(head);
    if (x === "loading") return v_flex().gap(12).child(head).child(h_flex().h(120).justify_center().items_center().gap(8).text_color(k.mutedFg).child(Spinner({ size: 14 })).child(`${this.explainModel.value()} is reading the diff… a big pull request takes a few minutes.`));
    if (x.error) return v_flex().gap(12).child(head).child(div().p(10).rounded(RADIUS.md).bg(alpha(k.destructive, 0.1)).text_size(TEXT.sm).text_color(k.foreground).child(x.error));
    const areas = x.areas ?? [];
    const max = Math.max(1, ...areas.map((a) => (a.added ?? 0) + (a.removed ?? 0)));
    const open = (this.explainOpen ??= new Set());
    return v_flex()
      .gap(12)
      .child(head)
      .child(v_flex().gap(8).child(div().text_size(TEXT.lg).font_semibold().whitespace_normal().child(x.headline ?? "")).child(TextView.markdown(`ex-sum-${keyOf(p)}`, x.summary ?? "").selectable(true).w_full()))
      .child(
        card("ex-ba", "Before and after",
          v_flex().rounded(RADIUS.md).border_1().border_color(k.border).overflow_hidden()
            .child(h_flex().gap(12).px(10).py(6).bg(k.muted).text_size(TEXT.xs).font_semibold().text_color(k.mutedFg).child(div().w(170).flex_none().child("")).child(div().flex_1().child(`On ${p.base}`)).child(div().flex_1().child("With this change")))
            .children((x.before_after ?? []).map((r, i) => h_flex().id(`ex-ba-${i}`).gap(12).px(10).py(8).items_start().border_t_1().border_color(k.border).text_size(TEXT.sm).child(div().w(170).flex_none().font_medium().text_color(k.foreground).whitespace_normal().child(r.aspect)).child(div().flex_1().min_w(0).text_color(k.mutedFg).whitespace_normal().child(r.before)).child(div().flex_1().min_w(0).text_color(k.foreground).whitespace_normal().child(r.after)))),
        ),
      )
      .when(Boolean(x.diagram?.nodes?.length || x.diagram?.art), (e) => e.child(card("ex-dg", x.diagram.title || "How it fits together", this.explainDiagram(k, p, x.diagram), div().text_size(TEXT.xs).text_color(k.dim).child(`${x.diagram.caption ?? ""}${x.diagram.nodes ? "  ·  outlined: what this change adds or alters" : "  (* new or changed)"}`))))
      .child(
        card("ex-areas", `Where it changes · ${x.files ?? 0} files, +${x.added ?? 0} −${x.removed ?? 0}`,
          h_flex().gap(12).text_size(TEXT.xs).text_color(k.mutedFg).child(h_flex().gap(4).items_center().child(div().size(8).rounded(2).bg(k.success)).child("lines added")).child(h_flex().gap(4).items_center().child(div().size(8).rounded(2).bg(k.destructive)).child("lines removed")),
          ...areas.map((a, i) => {
            const on = open.has(`${keyOf(p)}:${i}`);
            const w = (n) => Math.max(n ? 3 : 0, Math.round(((n ?? 0) / max) * 100));
            return v_flex().id(`ex-a-${i}`).gap(4).py(4).cursor_pointer().on_click((_e, cx) => { on ? open.delete(`${keyOf(p)}:${i}`) : open.add(`${keyOf(p)}:${i}`); cx.notify(); })
              .child(h_flex().gap(10).items_center()
                .child(div().w(220).flex_none().truncate().text_size(TEXT.sm).font_medium().text_color(k.foreground).child(a.name))
                .child(h_flex().id(`ex-bar-${i}`).flex_1().min_w(0).h(10).gap(2).items_center().tooltip(`${a.name}: +${a.added ?? "?"} −${a.removed ?? "?"} in ${(a.files ?? []).length} file${(a.files ?? []).length === 1 ? "" : "s"}`)
                  .child(div().h(8).rounded(4).bg(k.success).w(`${w(a.added)}%`))
                  .child(div().h(8).rounded(4).bg(k.destructive).w(`${w(a.removed)}%`)))
                .child(div().w(110).flex_none().text_right().text_size(TEXT.xs).font_family("JetBrains Mono").text_color(k.mutedFg).child(a.added == null ? "counting…" : `+${a.added} −${a.removed} · ${a.files.length}`)))
              .child(div().text_size(TEXT.xs).text_color(k.mutedFg).whitespace_normal().child(a.what))
              .when(on, (e) => e.children((a.files ?? []).map((f) => div().id(`ex-f-${i}-${f}`).pl(12).text_size(TEXT.xs).font_family("JetBrains Mono").text_color(k.foreground).child(f))));
          }),
          div().text_size(TEXT.xs).text_color(k.dim).child("Click an area for its files."),
        ),
      )
      .when((x.watch ?? []).length > 0, (e) => e.child(card("ex-watch", "What you sign up for", ...x.watch.map((t, i) => h_flex().id(`ex-w-${i}`).gap(8).items_start().child(Icon("triangle-alert", { size: 14, color: k.warning })).child(div().flex_1().min_w(0).text_size(TEXT.sm).whitespace_normal().child(t))))))
      .child(h_flex().gap(8).child(Button("prs-explain-files", { label: "Files changed", icon: "git-commit", size: "sm", variant: "outline", onClick: (_e, cx) => { this.view = "files"; this.pfiles.load(cx, p); cx.notify(); } })));
  }

  /** The quiz written earlier for this pull request, with your answers, if any. */
  loadQuiz(cx, p) {
    if (this.quiz.has(keyOf(p))) return;
    cx.spawn(async (cx) => {
      const { home } = await hub.install();
      // Still being written (a job this page or another started): followed until its marker goes.
      const base = `${home}/.cache/cockpit/quiz/${p.repo.replace("/", "__")}__${p.number}.json`;
      const running = await readTextFile(`${base}.running`).catch(() => null);
      if (running !== null) {
        this.quiz.set(keyOf(p), "loading");
        this.jobs.set(`quiz:${keyOf(p)}`, { kind: "quiz", p, model: JSON.parse(running || "{}").model, at: 0 });
        return cx.notify();
      }
      const text = await readTextFile(`${home}/.cache/cockpit/quiz/${p.repo.replace("/", "__")}__${p.number}.json`).catch(() => null);
      if (text && !this.quiz.has(keyOf(p))) {
        try {
          const d = JSON.parse(text);
          this.quiz.set(keyOf(p), d);
          for (const q of d.questions ?? []) if (q.path) this.drafts.ensureFile(cx, p, q.path);
        } catch {}
      }
      cx.notify();
    });
  }

  /** A new quiz from the picked gateway model (bin/cockpit-explain.py quiz): the change and the draft's comments. */
  writeQuiz(cx, p) {
    this.startJob(cx, "quiz", p);
  }

  writeExplain(cx, p) {
    this.startJob(cx, "explain", p);
  }

  /** Your answer, kept in the quiz's file so the score stays. */
  answer(cx, p, qi, choice) {
    const d = this.quiz.get(keyOf(p));
    if (!d?.questions || d.answers?.[qi] != null) return;
    d.answers = { ...(d.answers ?? {}), [qi]: choice };
    cx.notify();
    cx.spawn(async () => {
      const { home } = await hub.install();
      const file = `${home}/.cache/cockpit/quiz/${p.repo.replace("/", "__")}__${p.number}.json`;
      const cur = await readTextFile(file).catch(() => null);
      await writeTextFile(file, JSON.stringify(d), cur).catch(() => {});
    });
  }

  /** {answered, right, total} of the quiz, or null when there is none. */
  quizScore(p) {
    const d = this.quiz.get(keyOf(p));
    if (!d?.questions?.length) return null;
    const a = d.answers ?? {};
    const answered = Object.keys(a).length;
    return { answered, right: d.questions.filter((q, i) => a[i] === q.answer).length, total: d.questions.length };
  }

  /** Quiz me: questions on the change and on the draft's comments, so what you post is what you understand. */
  quizPage(k, p) {
    const x = this.quiz.get(keyOf(p));
    const ready = x && x !== "loading" && !x.error && x.questions;
    const sc = this.quizScore(p);
    const head = v_flex().gap(10).p(14).rounded(RADIUS.lg).border_1().border_color(k.border).bg(k.card)
      .child(h_flex().gap(8).items_center().child(Icon("circle-help", { size: 16, color: k.ring })).child(div().text_size(TEXT.base).font_semibold().child("Quiz me on this pull request")).child(div().flex_1())
        .when(ready && x.head !== p.head, (e) => e.child(Badge("written for an older head", "warning")))
        .when(Boolean(sc), (e) => e.child(Badge(`${sc.right}/${sc.total} right${sc.answered < sc.total ? ` · ${sc.total - sc.answered} to go` : ""}`, sc.answered < sc.total ? "secondary" : sc.right / sc.total >= 0.75 ? "success" : "warning"))))
      .child(div().text_size(TEXT.xs).text_color(k.mutedFg).child("Before your name goes on the review: what the change does, how it behaves, and whether the agent's comments hold up. Answer first; the why shows after."))
      .child(h_flex().gap(8).items_start().child(div().flex_1().min_w(0).child(this.explainModel.element(k, "quiz"))).child(Button("prs-quiz-go", { label: x === "loading" ? "Writing…" : ready ? "New quiz" : "Write the quiz", icon: "sparkles", size: "sm", disabled: x === "loading" || !this.explainModel.value(), tooltip: this.explainModel.value() ? undefined : "Pick a model first", onClick: (_e, cx) => this.writeQuiz(cx, p) })));
    if (!x) return v_flex().gap(12).child(head);
    if (x === "loading") return v_flex().gap(12).child(head).child(h_flex().h(120).justify_center().items_center().gap(8).text_color(k.mutedFg).child(Spinner({ size: 14 })).child(`${this.explainModel.value()} is reading the diff and the draft…`));
    if (x.error) return v_flex().gap(12).child(head).child(div().p(10).rounded(RADIUS.md).bg(alpha(k.destructive, 0.1)).text_size(TEXT.sm).child(x.error));
    const ABOUT = { behaviour: "How it behaves", design: "Why it is built this way", risk: "What could break", comment: "An agent's comment" };
    const answers = x.answers ?? {};
    return v_flex()
      .gap(12)
      .child(head)
      .children(
        x.questions.map((q, i) => {
          const got = answers[i];
          const done = got != null;
          const range = q.start_line ? `${q.start_line}-${q.line}` : q.line ? String(q.line) : "";
          return v_flex().id(`qz-${i}`).gap(10).p(14).rounded(RADIUS.lg).border_1().border_color(!done ? k.border : got === q.answer ? alpha(k.success, 0.6) : alpha(k.destructive, 0.6)).bg(k.card)
            .child(h_flex().gap(8).items_center().child(div().text_size(TEXT.xs).text_color(k.dim).child(`${i + 1} / ${x.questions.length}`)).child(Badge(ABOUT[q.about] ?? q.about, q.about === "comment" ? "info" : "secondary")).when(Boolean(q.path), (e) => e.child(Mono(`${q.path}${range ? `:${range}` : ""}`, { size: TEXT.xs, color: k.mutedFg }))))
            .children(q.path && q.about === "comment" ? [this.drafts.snippet(k, p, q.path, range)].filter(Boolean) : [])
            .child(TextView.markdown(`qz-q-${keyOf(p)}-${i}`, q.question).selectable(true).w_full())
            .child(
              v_flex().gap(6).children(
                q.choices.map((c, j) => {
                  const right = j === q.answer, mine = j === got;
                  const tone = !done ? null : right ? k.success : mine ? k.destructive : null;
                  return h_flex().id(`qz-${i}-${j}`).gap(10).px(10).py(8).items_start().rounded(RADIUS.md).border_1()
                    .border_color(tone ? alpha(tone, 0.7) : k.border).bg(tone ? alpha(tone, 0.08) : k.background)
                    .when(!done, (e) => e.cursor_pointer().hover((h) => h.bg(k.accent)).on_click((_e, cx) => this.answer(cx, p, i, j)))
                    .child(div().w(18).flex_none().text_size(TEXT.sm).font_semibold().text_color(tone ?? k.mutedFg).child(done && right ? "✓" : done && mine ? "✗" : "ABCD"[j] ?? "·"))
                    .child(div().flex_1().min_w(0).text_size(TEXT.sm).whitespace_normal().text_color(k.foreground).child(c));
                }),
              ),
            )
            .when(done, (e) => e.child(v_flex().gap(4).p(10).rounded(RADIUS.md).border_l_2().border_color(got === q.answer ? k.success : k.destructive).bg(alpha(k.info, 0.05)).child(div().text_size(TEXT.xs).font_semibold().text_color(got === q.answer ? k.success : k.destructive).child(got === q.answer ? "Right" : "Not quite")).child(TextView.markdown(`qz-x-${keyOf(p)}-${i}`, q.explain ?? "").selectable(true).w_full())));
        }),
      )
      .when(Boolean(sc) && sc.answered === sc.total, (e) => e.child(h_flex().gap(10).p(14).items_center().rounded(RADIUS.lg).bg(alpha(sc.right / sc.total >= 0.75 ? k.success : k.warning, 0.1)).child(div().flex_1().text_size(TEXT.sm).child(sc.right / sc.total >= 0.75 ? `${sc.right} of ${sc.total}: you know this change.` : `${sc.right} of ${sc.total}: worth another look before posting: Explain and Files changed have the parts you missed.`)).child(Button("prs-quiz-back", { label: "Back to the review", size: "sm", variant: "outline", onClick: (_e, cx) => ((this.view = null), cx.notify()) }))));
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
              .flex_wrap()
              .pt(4)
              .child(Button("prs-open", { label: "Open PR", icon: "external", size: "sm", variant: "outline", onClick: (_e, cx) => cx.spawn(async () => hub.openUrl(p.url)) }))
              .child(Button("prs-files", { label: `Files changed${this.pfiles.files(p) ? ` · ${this.pfiles.files(p).length}` : ""}`, icon: "git-commit", size: "sm", variant: "outline", tooltip: "Every changed file as a diff or in full; click a line to comment on it", onClick: (_e, cx) => { this.view = "files"; this.pfiles.load(cx, p); this.drafts.load(cx, p).then((c) => c && cx.notify()); cx.notify(); } }))
              .child(Button("prs-explain", { label: "Explain", icon: "sparkles", size: "sm", variant: "outline", tooltip: "What this pull request does and how it differs from main, with a diagram, written by a gateway model", onClick: (_e, cx) => { this.view = "explain"; this.loadExplain(cx, p); cx.notify(); } }))
              .child(Button("prs-quiz", { label: this.quizScore(p) ? `Quiz · ${this.quizScore(p).right}/${this.quizScore(p).total}` : "Quiz me", icon: "circle-help", size: "sm", variant: "outline", tooltip: "Questions on the change and on the agent's comments, before your name goes on the review", onClick: (_e, cx) => { this.view = "quiz"; this.loadQuiz(cx, p); cx.notify(); } }))
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
            ...this.mergeBlock(k, p),
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
    const sc = this.docked ? null : shared("cockpit.prs.scope");
    if (sc && sc.at !== this.scopeAt) {
      this.scopeAt = sc.at;
      this.scope = sc.scope;
      this.repoF = null;
    }
    const want = this.docked ? null : shared("cockpit.prs.focus");
    if (!want) this.focused = null;
    if (want && want !== this.focused) {
      this.focused = want;
      const hit = list.find((p) => keyOf(p) === want);
      if (hit) { this.scope = "mine"; this.repoF = null; cx.timer.after(1, (cx) => this.select(cx, hit)); }
    }
    const working = this.agentsOn();
    const progress = list.filter((p) => this.draftInfo.has(keyOf(p)) || working.has(keyOf(p)));
    const inScope = { mine: d?.mine ?? [], review: (d?.assigned ?? []).filter((p) => p.turn?.who !== "none"), progress };
    const all = inScope[this.scope] ?? inScope.review;
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
    const agentN = all.filter((p) => working.has(keyOf(p))).length;
    const summary = this.scope === "progress" ? `${agentN} with an agent on it · ${all.length - agentN} drafted` : this.scope === "mine" ? `${youN} on you · ${all.length - youN} waiting` : `${youN} for you · ${all.length - youN} team`;
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
          .child(Tabs("prs-scope", { value: this.scope, onChange: (v, cx) => ((this.scope = v), (this.repoF = null), (this.authorF = null), cx.notify()), items: [{ value: "review", label: "To review", count: inScope.review.length }, { value: "progress", label: "In progress", count: inScope.progress.length }, { value: "mine", label: "Yours", count: inScope.mine.length }] }))
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
      .child(v_flex().border_x_1().border_b_1().border_color(k.border).rounded_b(RADIUS.lg).children(shownList.length ? shownList.map((p) => this.row(k, p, working.get(keyOf(p)))) : [h_flex().h(120).justify_center().items_center().text_color(k.mutedFg).child(this.scope === "progress" && !progress.length ? "Nothing in progress: a review draft, or an agent started on a pull request, puts it here." : "No pull requests match.")]));
    const sel = list.find((p) => keyOf(p) === this.sel) ?? null;
    const yours = list.filter((p) => p.turn?.who === "you").length;
    return v_flex()
      .id("prs")
      .relative()
      .size_full()
      .bg(k.background)
      .text_color(k.foreground)
      .text_size(TEXT.base)
      .when(Boolean(this.docked), (e) =>
        e.child(
          h_flex().flex_none().h(36).px(12).gap(8).items_center().border_b_1().border_color(k.border).bg(k.muted)
            .child(Icon("git-pull-request", { size: 14, color: k.mutedFg }))
            .child(Mono(this.docked, { size: TEXT.xs, color: k.mutedFg }))
            .child(div().flex_1())
            .child(Button("prs-dock-full", { label: "Open in Pull requests", icon: "external", size: "sm", variant: "ghost", tooltip: "This pull request on the Pull requests page, full width", onClick: () => { const hit = list.find((x) => keyOf(x) === this.docked); if (hit) { setShared("cockpit.prs.scope", { scope: hit.role === "author" ? "mine" : "review", at: Date.now() }); setShared("cockpit.prs.focus", keyOf(hit)); run("layout.select", { stack: "center", child: "prs" }); setShared("cockpit.app", "prs"); } } })),
        ),
      )
      .when(!this.docked, (e) => e.child(
        PageHeader({
          icon: "git-pull-request",
          title: "Pull requests",
          description: "Yours and the ones you review: whose move it is, approvals, reviewers, CI, and an agent to work on them",
          aside: d ? Badge(yours ? `${yours} on you` : "nothing on you", yours ? "warning" : "success") : null,
          actions: [Button("prs-refresh", { label: this.busy === "refresh" ? "Asking…" : "Refresh", icon: "rotate-ccw", variant: "outline", size: "sm", disabled: this.busy === "refresh", onClick: (_e, cx) => this.pull(cx, true) })],
        }),
      ))
      .child(
        !d
          ? h_flex().h(160).justify_center().items_center().gap(8).text_color(k.mutedFg).child(Spinner({ size: 14 })).child("Asking GitHub…")
          : d.error && !list.length
            ? Empty({ icon: "git-pull-request", title: "Could not read GitHub", description: d.error })
            : sel && this.view === "files"
              ? v_flex()
                  .id("prs-files-page")
                  .flex_1()
                  .min_h(0)
                  .px(24)
                  .py(16)
                  .gap(12)
                  .child(h_flex().flex_none().gap(8).items_center().child(Button("prs-back", { label: sel.title, icon: "chevron-left", variant: "ghost", size: "sm", onClick: (_e, cx) => ((this.view = null), cx.notify()) })).child(div().text_size(TEXT.sm).font_semibold().child("Files changed")))
                  .child(this.pfiles.render(k, sel, this.drafts, this.cfg))
            : sel && this.view === "quiz"
              ? v_flex()
                  .id("prs-quiz-scroll")
                  .flex_1()
                  .min_h(0)
                  .overflow_y_scrollbar()
                  .px(24)
                  .py(16)
                  .gap(12)
                  .child(h_flex().gap(8).items_center().child(Button("prs-back", { label: sel.title, icon: "chevron-left", variant: "ghost", size: "sm", onClick: (_e, cx) => ((this.view = null), cx.notify()) })).child(div().text_size(TEXT.sm).font_semibold().child("Quiz")))
                  .child(this.quizPage(k, sel))
            : sel && this.view === "explain"
              ? v_flex()
                  .id("prs-explain-scroll")
                  .on_size_change((size, cx) => { if (Math.abs((this.width ?? 0) - size.width) > 8) { this.width = size.width; cx.notify(); } })
                  .flex_1()
                  .min_h(0)
                  .overflow_y_scrollbar()
                  .px(24)
                  .py(16)
                  .gap(12)
                  .child(h_flex().gap(8).items_center().child(Button("prs-back", { label: sel.title, icon: "chevron-left", variant: "ghost", size: "sm", onClick: (_e, cx) => ((this.view = null), cx.notify()) })).child(div().text_size(TEXT.sm).font_semibold().child("Explain")))
                  .child(this.explainPage(k, sel))
            : sel
              ? v_flex()
                  .id("prs-detail-scroll")
                  .flex_1()
                  .min_h(0)
                  .overflow_y_scrollbar()
                  .px(24)
                  .py(16)
                  .gap(12)
                  .child(h_flex().gap(8).items_center().child(Button("prs-back", { label: this.view === "files" ? sel.title : "Pull requests", icon: "chevron-left", variant: "ghost", size: "sm", onClick: (_e, cx) => (this.view === "files" ? (this.view = null) : ((this.sel = null), this.docked || setShared("cockpit.prs.focus", null)), cx.notify()) })).when(this.view === "files", (e) => e.child(div().text_size(TEXT.sm).font_semibold().child("Files changed"))))
                  .child(this.view === "files" ? this.pfiles.render(k, sel, this.drafts, this.cfg) : this.detail(k, sel, cx))
              : listView,
      )
      .when(Boolean(this.drafts.confirm), (e) => {
        const dp = this.drafts.confirm.p;
        const de = this.drafts.m.get(keyOf(dp));
        const n = de?.exists ? this.drafts.counts(de) : { lines: 0, replies: 0 };
        const qs = this.quizScore(dp);
        const quizNote = !qs ? " You have not taken the quiz on it (Quiz me)." : qs.answered < qs.total ? ` Quiz: ${qs.answered} of ${qs.total} answered.` : ` Quiz: ${qs.right} of ${qs.total} right.`;
        const verb = de?.verdict === "APPROVE" ? "an approval" : de?.verdict === "REQUEST_CHANGES" ? "a request for changes" : "a review";
        return e.child(
          AlertDialog("prs-post", {
            title: this.drafts.confirm.pending ? `Keep the draft on GitHub as pending on ${dp.repo.split("/")[1]}#${dp.number}?` : `Post ${verb} on ${dp.repo.split("/")[1]}#${dp.number}?`,
            description: this.drafts.confirm.pending ? `${n.lines} line comment${n.lines === 1 ? "" : "s"} are saved on GitHub as a pending review. Only you see it, in VS Code's pull request view and on the PR page, until you submit it. Nothing is published.` : `${n.lines} line comment${n.lines === 1 ? "" : "s"} and ${n.replies} repl${n.replies === 1 ? "y" : "ies"} go to GitHub under your name, visible to everyone on the pull request.${quizNote}`,
            confirmLabel: this.drafts.confirm.pending ? "Keep as pending" : "Post review",
            onCancel: (_e, cx) => ((this.drafts.confirm = null), cx.notify()),
            onConfirm: (_e, cx) => this.drafts.post(cx, dp, (cx) => this.readConvo(cx, dp), Boolean(this.drafts.confirm.pending)),
          }),
        );
      })
      .when(Boolean(this.rebaseAsk), (e) =>
        e.child(
          AlertDialog("prs-rebase-ask", {
            title: `Rebase ${this.rebaseAsk.repo.split("/")[1]}#${this.rebaseAsk.number} onto ${this.rebaseAsk.base}?`,
            description: `The branch ${this.rebaseAsk.branch} is rebased in a scratch worktree and force-pushed (only if nobody pushed to it meanwhile). Reviewers see the history rewritten.`,
            confirmLabel: "Rebase and push",
            destructive: true,
            onCancel: (_e, cx) => ((this.rebaseAsk = null), cx.notify()),
            onConfirm: (_e, cx) => this.rebaseNow(cx, this.rebaseAsk),
          }),
        ),
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
