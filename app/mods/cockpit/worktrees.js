// The Worktrees page: every git worktree of the repositories you work in, whoever made it (a pull request's page, an agent that
// works in its own, you): the branch, what is changed in it, the pull request it is for, which agents run there, and buttons to
// open it in a tab or remove it. Data: bin/cockpit-worktree.py --list.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, notify, panes, run } from "herdr";
import * as hub from "./hub.js";
import { tokens, alpha, TEXT, RADIUS, Badge, Button, Card, PageHeader, Empty, Mono, Spinner, AlertDialog, Chip, openMenu } from "./ui.js";
import { prs, prsConfig, ago } from "./prsdata.js";
import { installedEditors, openInEditor } from "./editors.js";
import { openInSpace } from "./agentlaunch.js";

export default class Worktrees {
  init(_p, cx) {
    this.list = null;
    this.busy = null;
    this.confirm = null;
    this.repo = null;
    this.editors = [];
    installedEditors().then((e) => ((this.editors = e), cx.notify()));
    this.load(cx);
    cx.timer.every(15000, (cx) => this.load(cx));
  }

  command(c, cx) {
    if (c === "show:worktrees" || c === "focus") this.load(cx);
    // From the "Open in…" menu: worktrees:openin:<editor>:<path>
    const m = c.match(/^worktrees:openin:([a-z-]+):(.+)$/);
    if (m) openInEditor(m[1], m[2]);
  }

  /** Reads again: the repositories are the folders agents and tabs are in, the configured ones, and the pull requests' repositories. */
  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const cfg = await prsConfig();
        const d = prs();
        const names = [...new Set([...(d?.mine ?? []), ...(d?.assigned ?? [])].map((p) => p.repo))];
        const roots = [...new Set([...panes().map((p) => p.cwd).filter(Boolean), ...Object.values(cfg?.prs?.repos ?? {}), ...names.map((n) => `~/${n.split("/")[1]}`)])];
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-worktree.py`, "--list", ...roots], { timeout: 90000 });
        this.list = JSON.parse(r.stdout || "{}").worktrees ?? [];
      } catch {
        this.list = this.list ?? [];
      }
      cx.notify();
    });
  }

  remove(cx, t) {
    cx.spawn(async (cx) => {
      this.busy = t.path;
      cx.notify();
      try {
        const { home } = await hub.install();
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-worktree.py`, "--remove-path", t.path, ...(t.dirty ? ["--force"] : [])], { timeout: 120000 });
        const d = JSON.parse(r.stdout || "{}");
        notify(d.error ? { title: "Not removed", body: d.error } : { title: "Worktree removed", body: t.path });
      } catch (e) {
        notify({ title: "Not removed", body: String(e?.message ?? e).slice(0, 160) });
      }
      this.busy = null;
      this.confirm = null;
      this.load(cx);
    });
  }

  row(k, t) {
    const here = panes().filter((p) => p.cwd && (p.cwd === t.path || p.cwd.startsWith(`${t.path}/`)) && p.program?.agent);
    return h_flex()
      .id(`wt-${t.path}`)
      .gap(10)
      .items_center()
      .p(12)
      .rounded(RADIUS.lg)
      .border_1()
      .border_color(here.length ? alpha(k.working, 0.5) : k.border)
      .bg(k.card)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(h_flex().gap(8).items_center().child(div().font_medium().truncate().child(t.branch)).when(t.main, (e) => e.child(Badge("main checkout", "secondary"))).when(Boolean(t.pr), (e) => e.child(Badge(`PR #${t.pr}`, "secondary"))))
          .child(div().text_size(TEXT.xs).text_color(k.dim).truncate().child(t.path))
          .child(Mono(`${t.head}${t.at ? ` · last commit ${ago(t.at)} ago` : ""}`, { size: TEXT.xs, color: k.mutedFg })),
      )
      .when(here.length > 0, (e) => e.child(Badge(here.length === 1 ? `${here[0].program?.name ?? "agent"} working here` : `${here.length} agents here`, "warning")))
      .child(t.dirty ? Badge(`${t.dirty} changed`, "warning") : Badge("clean", "success"))
      .when(this.editors.length > 0, (e) => e.child(Button(`wt-in-${t.path}`, { label: "Open in…", icon: "code", size: "sm", variant: "outline", onClick: () => openMenu(this.editors.map(([id, , label]) => ({ label, icon: "code", command: `worktrees:openin:${id}:${t.path}` })), { width: 200 }) })))
      .child(Button(`wt-open-${t.path}`, { label: "Open in a tab", icon: "folder", size: "sm", variant: "outline", onClick: () => openInSpace(t.repo_name, { name: t.name, folder: t.path }) }))
      .when(!t.main, (e) => e.child(Button(`wt-rm-${t.path}`, { label: this.busy === t.path ? "Removing…" : "Remove", size: "sm", variant: "ghost", disabled: this.busy === t.path || here.length > 0, tooltip: here.length ? "An agent is working here" : undefined, onClick: (_e, cx) => ((this.confirm = t), cx.notify()) })));
  }

  render() {
    const k = tokens();
    const all = this.list;
    const repos = [...new Set((all ?? []).map((t) => t.repo_name))].sort();
    const shown = (all ?? []).filter((t) => !this.repo || t.repo_name === this.repo);
    const extra = (all ?? []).filter((t) => !t.main).length;
    return v_flex()
      .id("worktrees")
      .relative()
      .size_full()
      .bg(k.background)
      .text_color(k.foreground)
      .text_size(TEXT.base)
      .child(PageHeader({ icon: "git-fork", title: "Worktrees", description: "Every worktree of your repositories: made for a pull request, by an agent, or by you", aside: all ? Badge(`${extra} besides the main checkouts`, "secondary") : null, actions: [Button("wt-refresh", { label: "Refresh", icon: "rotate-ccw", variant: "outline", size: "sm", onClick: (_e, cx) => this.load(cx) })] }))
      .child(
        !all
          ? h_flex().h(160).justify_center().items_center().gap(8).text_color(k.mutedFg).child(Spinner({ size: 14 })).child("Reading the repositories…")
          : v_flex()
              .id("wt-scroll")
              .flex_1()
              .min_h(0)
              .overflow_y_scrollbar()
              .gap(10)
              .px(24)
              .py(16)
              .child(h_flex().gap(6).flex_wrap().children([Chip("all repos", { id: "wt-repo-all", color: this.repo ? undefined : k.ring, onClick: (_e, cx) => ((this.repo = null), cx.notify()) }), ...repos.map((r) => Chip(r, { id: `wt-repo-${r}`, color: this.repo === r ? k.ring : undefined, onClick: (_e, cx) => ((this.repo = this.repo === r ? null : r), cx.notify()) }))]))
              .children(shown.length ? shown.map((t) => this.row(k, t)) : [Empty({ icon: "git-fork", title: "No worktrees", description: "A pull request's page makes one; so do agents that work apart from your checkout." })]),
      )
      .when(Boolean(this.confirm), (e) =>
        e.child(
          AlertDialog("wt-confirm", {
            title: `Remove ${this.confirm.name}?`,
            description: this.confirm.dirty ? `It has ${this.confirm.dirty} uncommitted change${this.confirm.dirty === 1 ? "" : "s"}, which are lost. The branch stays unless it was made for a pull request.` : "The folder is deleted; the branch stays unless it was made for a pull request.",
            confirmLabel: "Remove worktree",
            destructive: true,
            onCancel: (_e, cx) => ((this.confirm = null), cx.notify()),
            onConfirm: (_e, cx) => this.remove(cx, this.confirm),
          }),
        ),
      );
  }
}
