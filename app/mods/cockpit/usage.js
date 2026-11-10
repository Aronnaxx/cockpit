// The Usage tab: each agent account's real rate limits (Claude Code, Codex, Antigravity), the 5-hour session window and
// the 7-day week, with % used, a tick where the window's time stands, the pace, a projection and the reset countdown.
// bin/cockpit-usage-sync.py asks each agent (cached, so cheap to call) and writes ~/.cache/cockpit/agent-usage.json;
// Home's Usage & Limits card and the sidebar's badge draw the same data through followUsage and AgentLimits.
// Context windows are not limits: they stay on Home's agent cards.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, readTextFile, setShared } from "herdr";
import * as hub from "./hub.js";
import { openCode } from "./code.js";
import { tokens, alpha, TEXT, RADIUS, Icon, Badge, Button, Card, PageHeader, Empty, Mono, Spinner, Progress, dur } from "./ui.js";

const WINDOW_LABEL = { "5h": "5-hour session", "7d": "Weekly" };

/** Runs the sync (it answers from its cache while fresh) and reads what it wrote. force asks every agent again. */
export async function syncUsage({ force = false } = {}) {
  const { cache, home } = await hub.install();
  const script = `${home}/.local/share/cockpit/herdr/helpers/cockpit-usage-sync.py`;
  await exec("python3", force ? [script, "--force"] : [script], { timeout: 90000 }).catch(() => null);
  const text = await readTextFile(`${cache}/agent-usage.json`);
  return text ? JSON.parse(text) : null;
}

/** The last days' token statistics (herdr/helpers/cockpit-usage-stats.py): the biggest sessions and what fills the context. */
export async function loadStats({ force = false } = {}) {
  const { home } = await hub.install();
  const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-usage-stats.py`, ...(force ? ["--force"] : [])], { timeout: 60000 }).catch(() => null);
  try {
    return JSON.parse(r?.stdout || "null");
  } catch {
    return null;
  }
}

/** Keeps a view's usage fresh: now, then every `every` ms; also sets the sidebar's Usage badge. */
export function followUsage(cx, onData, { every = 15000 } = {}) {
  const pull = (cx, force) =>
    cx.spawn(async (cx) => {
      try {
        const data = await syncUsage({ force });
        if (data) {
          setShared("badge.usage", usageBadge(data));
          onData(data, cx);
        }
      } catch {}
      cx.notify();
    });
  pull(cx, false);
  cx.timer.every(every, (cx) => pull(cx, false));
  return { refresh: (cx) => pull(cx, true) };
}

/** The highest % among an agent's (or every agent's) official windows. */
export function worst(windows) {
  return Math.max(0, ...(windows ?? []).filter((w) => w.source !== "estimate" || w.budget_tokens).map((w) => w.percent ?? 0));
}

/** The sidebar badge: the worst window when it is at 80% or more. */
export function usageBadge(data) {
  const p = Math.round(worst((data?.agents ?? []).flatMap((a) => a.windows ?? [])));
  return p >= 75 ? { count: `${p}%`, tone: p >= 90 ? "destructive" : "warning" } : null;
}

/** The bar's colour as Claude Code's own status line has it: green, amber from 75% (or when ahead of pace), red from 90%. */
export function toneOf(k, w) {
  const p = w.percent ?? 0;
  return p >= 90 ? k.destructive : p >= 75 || w.ahead ? k.warning : k.success;
}

/** When the window hits 100% at its current pace, in ms from now, if that comes before its reset; else null. */
export function projection(w) {
  if (!w.resets_at || w.elapsed == null || !w.percent || w.percent >= 100) return null;
  const spent = w.elapsed * w.window_mins * 60000;
  if (spent < 10 * 60000) return null;
  const toFull = ((100 - w.percent) / w.percent) * spent;
  return toFull < w.resets_at - Date.now() ? toFull : null;
}

const tokensText = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n ?? 0}`);

/** One window as a bar: label, % used (▲ when ahead of pace), a tick at the time gone, and the reset countdown. */
export function LimitRow(id, w, { compact = false, now = Date.now() } = {}) {
  const k = tokens();
  const est = w.source === "estimate";
  const p = Math.max(0, Math.min(100, w.percent ?? 0));
  const tone = est && !w.budget_tokens ? k.mutedFg : toneOf(k, w);
  const left = w.resets_at ? dur(w.resets_at - now) : null;
  const full = projection(w);
  const value = est && !w.budget_tokens ? `${tokensText(w.used_tokens)} tok` : `${Math.round(p)}%`;
  const tip = [
    `${w.group ? `${w.group} · ` : ""}${WINDOW_LABEL[w.name] ?? w.name}: ${est && !w.budget_tokens ? `${tokensText(w.used_tokens)} tokens (no budget set)` : `${p}% used`}`,
    left ? `resets in ${left}` : null,
    w.elapsed != null ? `${Math.round(w.elapsed * 100)}% of the window gone${w.ahead ? ", ahead of pace" : ""}` : null,
    full ? `at this pace full in ~${dur(full)}` : null,
    est ? "estimated from local transcripts" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return h_flex()
    .id(id)
    .gap(8)
    .items_center()
    .tooltip(tip)
    .child(div().w(compact ? 20 : 26).flex_none().text_size(TEXT.xs).font_medium().text_color(k.mutedFg).child(w.name))
    .child(
      div()
        .relative()
        .flex_1()
        .h(compact ? 6 : 10)
        .rounded(5)
        .bg(alpha(tone, 0.2))
        .child(div().absolute().left(0).top(0).h_full().rounded(5).bg(tone).w(`${est && !w.budget_tokens ? 0 : p}%`).transition("width", { duration: 400, easing: "ease-out" }))
        .when(w.elapsed != null, (e) => e.child(div().absolute().top(-2).h(compact ? 9 : 11).w(2).rounded(1).bg(k.foreground).opacity(0.6).left(`${Math.min(99, w.elapsed * 100)}%`))),
    )
    .child(
      h_flex()
        .w(compact ? 40 : 52)
        .flex_none()
        .justify_end()
        .gap(2)
        .text_size(TEXT.xs)
        .font_family("JetBrains Mono")
        .text_color(w.ahead || p >= 80 ? tone : k.foreground)
        .when(Boolean(w.ahead), (e) => e.child("▲"))
        .child(value),
    )
    .child(div().w(compact ? 30 : 40).flex_none().text_right().text_size(TEXT.xs).font_family("JetBrains Mono").text_color(k.dim).child(left ?? "—"));
}

/** An agent's windows, grouped by model group (Antigravity has three), under the agent's name. */
export function AgentLimits(id, a, { compact = false, now = Date.now() } = {}) {
  const k = tokens();
  const groups = [];
  for (const w of a.windows ?? []) {
    let g = groups.find((x) => x.name === (w.group ?? null));
    if (!g) groups.push((g = { name: w.group ?? null, windows: [] }));
    g.windows.push(w);
  }
  for (const g of groups) g.windows.sort((x, y) => (x.name === "5h" ? -1 : 1) - (y.name === "5h" ? -1 : 1));
  const badge = a.source === "estimate" ? "est." : a.stale ? "stale" : null;
  return v_flex()
    .id(id)
    .gap(compact ? 4 : 6)
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(Icon(a.icon ?? "bot", { size: 13, color: k.mutedFg }))
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.sm).font_medium().text_color(k.foreground).child(a.name))
        .when(Boolean(badge), (e) => e.child(div().text_size(TEXT.xs).text_color(a.stale ? k.warning : k.dim).child(badge))),
    )
    .children(
      groups.map((g) =>
        v_flex()
          .gap(3)
          .when(Boolean(g.name), (e) => e.child(div().pl(1).text_size(TEXT.xs).text_color(k.dim).child(g.name)))
          .children(g.windows.map((w) => LimitRow(`${id}-${g.name ?? ""}-${w.name}`, w, { compact, now }))),
      ),
    );
}

export default class Usage {
  init(_props, cx) {
    this.data = null;
    this.now = Date.now();
    this.refreshing = false;
    this.stats = null;
    const pullStats = (cx, force) =>
      cx.spawn(async (cx) => {
        this.stats = (await loadStats({ force })) ?? this.stats;
        cx.notify();
      });
    pullStats(cx, false);
    cx.timer.every(600000, (cx) => pullStats(cx, false));
    this.pullStats = pullStats;
    this.slots = null;
    const pullSlots = (cx) =>
      cx.spawn(async (cx) => {
        try {
          const { home } = await hub.install();
          const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-slots.py`], { timeout: 40000 });
          this.slots = JSON.parse(r.stdout || "{}");
        } catch (e) {
          this.slots = { error: String(e?.message ?? e).slice(0, 160) };
        }
        cx.notify();
      });
    pullSlots(cx);
    cx.timer.every(15000, (cx) => pullSlots(cx));
    this.follow = followUsage(cx, (data, cx) => {
      this.data = data;
      this.refreshing = false;
      this.now = Date.now();
    });
    cx.timer.every(30000, (cx) => {
      this.now = Date.now();
      cx.notify();
    });
  }

  command(c, cx) {
    if (c === "refresh") this.refresh(cx);
  }

  refresh(cx) {
    this.pullStats?.(cx, true);
    this.refreshing = true;
    this.follow.refresh(cx);
    cx.notify();
  }

  editBudgets(cx) {
    cx.spawn(async () => {
      const { home } = await hub.install();
      await openCode(`${home}/.config/cockpit/config.json`);
    });
  }

  /** A big card per agent: its windows, each with %, reset time, pace and projection spelled out. */
  agentCard(k, a) {
    const facts = [];
    for (const w of a.windows ?? []) {
      const full = projection(w);
      if (full) facts.push({ tone: k.warning, text: `${w.group ? `${w.group} ` : ""}${WINDOW_LABEL[w.name]}: at this pace full in ~${dur(full)}, before it resets in ${dur(w.resets_at - this.now)}` });
    }
    if (a.litellm?.spend != null) facts.push({ tone: k.mutedFg, text: `LiteLLM key ${a.litellm.key_alias ?? ""}: $${Number(a.litellm.spend).toFixed(2)}${a.litellm.max_budget ? ` of $${a.litellm.max_budget}` : ""}${a.litellm.budget_reset_at ? `, resets ${new Date(a.litellm.budget_reset_at).toLocaleString()}` : ""}` });
    if (a.source === "estimate") facts.push({ tone: k.dim, text: `No limits from ${a.name}${a.error ? ` (${a.error})` : ""}: tokens from local transcripts${worst(a.windows) ? " against usage.budgets" : "; set usage.budgets to see %"}.` });
    else if (a.stale) facts.push({ tone: k.warning, text: `Last answer ${a.fetched_at ? dur(this.now - a.fetched_at) : ""} ago: ${a.error ?? "the latest ask failed"}` });
    const ctx = a.context;
    return Card({
      id: `usage-card-${a.id}`,
      padding: 18,
      gap: 14,
      children: [
        AgentLimits(`usage-tab-${a.id}`, a, { now: this.now }),
        ...facts.map((f, i) => h_flex().id(`usage-fact-${a.id}-${i}`).gap(6).items_start().child(div().mt(5).size(5).rounded(3).flex_none().bg(f.tone)).child(div().flex_1().text_size(TEXT.sm).text_color(k.mutedFg).child(f.text))),
        h_flex()
          .gap(12)
          .items_center()
          .pt(2)
          .border_t_1()
          .border_color(k.border)
          .child(div().text_size(TEXT.xs).text_color(k.dim).child([a.fetched_at ? `asked ${dur(this.now - a.fetched_at)} ago` : "never asked", (a.windows ?? []).find((w) => w.plan)?.plan ? `${(a.windows ?? []).find((w) => w.plan).plan} plan` : null].filter(Boolean).join(" · ")))
          .child(div().flex_1())
          .when(Boolean(ctx), (e) => e.child(div().text_size(TEXT.xs).text_color(k.dim).child(`latest session context ${Math.round(ctx.percent)}% of ${tokensText(ctx.window)}`))),
      ],
    });
  }

  /** What a tool's output or a kind of content is, for the colours (as in Claude's own /context). */
  kindOf(name) {
    const n = String(name).toLowerCase();
    if (n === "reasoning") return "Reasoning";
    if (n === "model text") return "Model text";
    if (n === "your prompts") return "Your prompts";
    if (/webfetch|websearch|web_search|fetch|search/.test(n)) return "Web and search";
    if (/^mcp__/.test(n)) return "MCP tools";
    if (/bash|shell|exec|sleep|terminal|command/.test(n)) return "Shell";
    if (/read|glob|grep|list|view|edit|write|patch|file/.test(n)) return "Files";
    return "Other tools";
  }

  /** OpenCode has no account limit: what limits it is the local model servers, each serving a fixed number of requests at once
   * (bin/cockpit-slots.py, from sparkDash). */
  openCodeCard(k) {
    const sl = this.slots;
    const hosts = sl?.hosts ?? [];
    return Card({
      id: "usage-card-opencode",
      padding: 18,
      gap: 12,
      children: [
        h_flex().gap(6).items_center().child(Icon("bot", { size: 13, color: k.mutedFg })).child(div().text_size(TEXT.sm).font_medium().text_color(k.foreground).child("OpenCode")),
        div().text_size(TEXT.xs).text_color(k.dim).child("No account limit. The local models serve a fixed number of requests at once:"),
        ...(!sl ? [h_flex().gap(8).items_center().child(Spinner({ size: 12 })).child(div().text_size(TEXT.xs).text_color(k.mutedFg).child("Asking sparkDash…"))] : sl.error ? [div().text_size(TEXT.xs).text_color(k.warning).child(sl.error)] : []),
        ...hosts.map((h) => {
          const busy = h.total ? h.active / h.total : 0;
          const tone = !h.online ? k.dim : busy >= 1 ? k.destructive : busy >= 0.5 ? k.warning : k.success;
          return v_flex().id(`slots-${h.id}`).gap(4)
            .tooltip(`${h.model ?? "no model loaded"}${h.quant ? ` · ${h.quant}` : ""}${h.context ? ` · ${Math.round(h.context / 1024)}k context` : ""}`)
            .child(h_flex().gap(8).items_center()
              .child(div().size(7).rounded(4).flex_none().bg(h.online ? k.success : k.dim))
              .child(div().flex_1().min_w(0).truncate().text_size(TEXT.sm).text_color(k.foreground).child(h.name))
              .child(Mono(h.online ? `${h.active}/${h.total} slots` : "offline", { size: TEXT.xs, color: h.online ? k.foreground : k.dim })))
            .child(h_flex().gap(2).children(Array.from({ length: Math.max(1, h.total) }, (_, i) => div().flex_1().h(6).rounded(3).bg(i < h.active ? tone : alpha(k.muted, 0.9)))))
            .child(div().text_size(TEXT.xs).text_color(k.dim).truncate().child([h.model, h.waiting ? `${h.waiting} queued` : null, h.tps ? `${Math.round(h.tps)} tok/s` : null].filter(Boolean).join(" · ")));
        }),
        h_flex().pt(2).border_t_1().border_color(k.border).child(div().text_size(TEXT.xs).text_color(k.dim).child(sl?.at ? `sparkDash · asked ${dur(this.now - sl.at)} ago` : "sparkDash")),
      ],
    });
  }

  /** One agent's column below its limits: its biggest sessions, then a colour-coded breakdown of what filled its context. */
  agentStats(k, key) {
    const st = this.stats;
    if (!st) return [null, null];
    const tk = tokensText;
    const COLORS = { Files: "#5b8def", Shell: "#e0803f", "Web and search": "#4fae93", "MCP tools": "#d6a03c", Reasoning: "#a278e0", "Model text": "#7fb069", "Your prompts": "#e07aa0", "Other tools": "#8a8f98" };
    const out = [null, null];
    const list = st.per_agent?.[key] ?? [];
    if (list.length) {
      const max = Math.max(1, ...list.map((s) => s.tokens));
      out[0] = (
        Card({
          id: `stats-sessions-${key}`,
          padding: 14,
          gap: 8,
          title: `Biggest sessions · ${st.days} days`,
          children: [
            ...list.map((s, i) =>
              v_flex()
                .id(`stat-s-${key}-${i}`)
                .gap(3)
                .tooltip(`${s.project ? `${s.project}\n` : ""}${tk(s.tokens)} tokens (input, output and reasoning) plus ${tk(s.cached)} read from cache${s.cost ? ` · $${s.cost.toFixed(2)}` : ""}${s.agents > 1 ? ` · ${s.agents} agent sessions` : ""}`)
                .child(h_flex().gap(8).items_center().child(div().flex_1().min_w(0).truncate().text_size(TEXT.sm).text_color(k.foreground).child(s.title ?? s.id)).child(Mono(tk(s.tokens), { color: k.foreground })))
                .child(Progress(s.tokens / max, { color: k.mutedFg, h: 4 })),
            ),
            div().text_size(TEXT.xs).text_color(k.dim).child(`${tk(st.by_agent?.[key]?.tokens ?? 0)} over ${st.by_agent?.[key]?.sessions ?? 0} sessions · ${tk(st.by_agent?.[key]?.cached ?? 0)} read from cache`),
          ],
        })
      );
    }
    const eaters = st.eaters?.[key] ?? [];
    if (eaters.length) {
      const total = eaters.reduce((n, x) => n + x.tokens, 0) || 1;
      out[1] = (
        Card({
          id: `stats-eaters-${key}`,
          padding: 14,
          gap: 10,
          title: "What fills the context",
          children: [
            div().text_size(TEXT.xs).text_color(k.dim).child(`about ${tk(total)} tokens over ${st.days} days`),
            h_flex()
              .id(`stat-bar-${key}`)
              .w_full()
              .h(8)
              .gap(1)
              .rounded(4)
              .overflow_hidden()
              .children(eaters.map((x) => div().h_full().w(`${Math.max(1.5, (x.tokens / total) * 100)}%`).bg(COLORS[this.kindOf(x.name)]))),
            ...eaters.map((x, i) =>
              h_flex()
                .id(`stat-e-${key}-${i}`)
                .gap(8)
                .items_center()
                .tooltip(`${x.name}: ${x.calls} calls · ${this.kindOf(x.name)}`)
                .child(div().size(10).flex_none().rounded(2).bg(COLORS[this.kindOf(x.name)]))
                .child(div().flex_1().min_w(0).truncate().text_size(TEXT.xs).text_color(k.mutedFg).child(x.name))
                .child(div().w(44).flex_none().text_right().child(Mono(tk(x.tokens), { size: TEXT.xs, color: k.foreground })))
                .child(div().w(40).flex_none().text_right().text_size(TEXT.xs).text_color(k.dim).child(`${Math.round((x.tokens / total) * 100)}%`)),
            ),
          ],
        })
      );
    }
    return out;
  }

  render(cx) {
    const k = tokens();
    const agents = this.data?.agents ?? [];
    const top = Math.round(worst(agents.flatMap((a) => a.windows ?? [])));
    const body = !this.data
      ? h_flex().h(160).justify_center().items_center().gap(8).text_color(k.mutedFg).child(Spinner({ size: 14 })).child("Asking the agents for their limits…")
      : !agents.length
        ? Empty({ icon: "gauge", title: "No agent usage yet", description: "Claude Code, Codex and Antigravity show up once they are installed and signed in." })
        : (() => {
            // Rows, not columns: every agent's limits side by side, then their biggest sessions, then what fills their context, so
            // each row's cards line up and share a height.
            const cols = [...agents.map((a) => ({ id: a.id, card: this.agentCard(k, a) })), { id: "opencode", card: this.openCodeCard(k) }];
            const stats = Object.fromEntries(cols.map((c) => [c.id, this.agentStats(k, c.id)]));
            const row = (id, cells) => h_flex().id(id).w_full().gap(16).items_stretch().children(cells.map((c, i) => v_flex().id(`${id}-${i}`).flex_1().min_w(0).children(c ? [c.flex_1()] : [])));
            const rows = [row("usage-row-limits", cols.map((c) => c.card))];
            if (cols.some((c) => stats[c.id][0])) rows.push(row("usage-row-sessions", cols.map((c) => stats[c.id][0])));
            if (cols.some((c) => stats[c.id][1])) rows.push(row("usage-row-context", cols.map((c) => stats[c.id][1])));
            return v_flex().w_full().gap(16).children(rows);
          })();
    return v_flex()
      .id("usage")
      .size_full()
      .bg(k.background)
      .text_color(k.foreground)
      .text_size(TEXT.base)
      .child(
        PageHeader({
          icon: "gauge",
          title: "Usage & Limits",
          description: "5-hour session and weekly limits per agent account · the tick marks how much of the window has gone",
          aside: this.data ? Badge(top ? `highest ${top}%` : "all clear", top >= 95 ? "destructive" : top >= 80 ? "warning" : "success", { dot: top >= 95 ? k.destructive : top >= 80 ? k.warning : k.success }) : null,
          actions: [
            Button("usage-budgets", { label: "Budgets", icon: "file-text", variant: "ghost", size: "sm", tooltip: "Edit usage.budgets (for estimated windows) in the cockpit config", onClick: (_e, cx) => this.editBudgets(cx) }),
            Button("usage-refresh", { label: this.refreshing ? "Asking…" : "Refresh", icon: "refresh-cw", variant: "outline", size: "sm", disabled: this.refreshing, onClick: (_e, cx) => this.refresh(cx) }),
          ],
        }),
      )
      .child(
        v_flex()
          .id("usage-scroll")
          .flex_1()
          .min_h(0)
          .px(24)
          .py(20)
          .gap(16)
          .overflow_y_scrollbar()
          .child(body)
          .when(Boolean(this.data?.updated_at), (e) => e.child(div().text_size(TEXT.xs).text_color(k.dim).child(`Updated ${dur(this.now - this.data.updated_at)} ago · Claude from Anthropic's usage endpoint, Codex from its app-server, Antigravity from agy /quota`))),
      );
  }
}
