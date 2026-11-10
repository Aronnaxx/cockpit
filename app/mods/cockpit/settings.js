// Cockpit's settings, in a window of their own, by section: Layout (the sidebar's tabs and sections, the bottom bar), AI (the model that explains pull requests and writes quizzes, what runs unasked, how hard and how
// long a quiz is, tab titles), Machines (the local model servers' slots) and the config file itself. Everything is
// ~/.config/cockpit/config.json, written a change at a time.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { notify, openOverlay, closeOverlay, props, readTextFile, writeTextFile } from "herdr";
import * as hub from "./hub.js";
import { openCode } from "./code.js";
import { tokens, alpha, TEXT, RADIUS, Button, Checkbox, Toggle, Card, Tabs, Icon, TextField } from "./ui.js";
import { ModelPicker } from "./modelpick.js";
import { APPS, DEFAULT_SPACES } from "./sidebar.js";

/** Opens the settings window over whatever is showing. */
export function openSettings(section = null) {
  openOverlay({ mod: "cockpit", props: { app: "settings", section }, kind: "dialog", width: 0.62, height: 0.8 });
}

const NAV = [
  ["layout", "Layout", "layout-dashboard", "Sidebar and bottom bar"],
  ["ai", "AI", "sparkles", "Explain, quizzes, titles"],
  ["machines", "Machines", "server", "Local model servers"],
  ["file", "Config file", "file-text", "Everything else"],
];

const SECTIONS = [
  ["usage", "Usage limits"],
  ["machines", "Machines"],
  ["omo", "OMO presets"],
];

export default class Settings {
  init(_p, cx) {
    this.section = props()?.section ?? _p?.section ?? "layout";
    this.ai = { auto: true, autoQuiz: true, difficulty: "standard", count: "fit", gate: false, pass: 75, reveal: "each" };
    // The model that explains and quizzes: any of the gateway's, saved as explain.model when picked.
    this.explainModel = new ModelPicker(cx, { placeholder: "Search the gateway's models", onPick: (m, cx) => this.save(cx, (cfg) => ({ ...cfg, explain: { ...(cfg.explain ?? {}), model: m } })) });
    this.slotsUrl = InputState.new({ placeholder: "http://127.0.0.1:5555" });
    this.slotsVia = InputState.new({ placeholder: "the machine sparkDash runs on (empty: this one)" });
    this.slotsUrl.on("blur", (_e, cx) => this.saveSlots(cx));
    this.slotsVia.on("blur", (_e, cx) => this.saveSlots(cx));
    this.spaces = DEFAULT_SPACES;
    this.titles = true;
    this.header = ["usage", "machines", "omo"];
    this.statusItems = ["agent", "mode", "usage", "machines", "omo", "tps"];
    const read = (cx) =>
      cx.spawn(async (cx) => {
        try {
          const { home } = await hub.install();
          const cfg = JSON.parse((await readTextFile(`${home}/.config/cockpit/config.json`)) ?? "{}");
          if (Array.isArray(cfg.spaces)) this.spaces = cfg.spaces.map((s) => (typeof s === "string" ? s : s.name));
          this.titles = cfg.titles?.enabled !== false;
          this.statusItems = (cfg.statusbar?.items ?? this.statusItems).filter((n) => ["agent", "mode", "usage", "machines", "omo", "tps"].includes(n));
          this.header = (cfg.sidebar?.header ?? this.header).filter((x) => SECTIONS.some(([n]) => n === x));
          this.ai = { auto: cfg.explain?.auto !== false, autoQuiz: cfg.explain?.auto_quiz !== false, difficulty: cfg.quiz?.difficulty ?? "standard", count: cfg.quiz?.count ?? "fit", gate: cfg.quiz?.gate === true, pass: Number(cfg.quiz?.pass ?? 75), reveal: cfg.quiz?.reveal === "end" ? "end" : "each" };
          this.explainModel.input.set_value(cfg.explain?.model ?? "agy/gemini-3.8-flash-medium");
          this.slotsUrl.set_value(cfg.usage?.slots?.url ?? "");
          this.slotsVia.set_value(cfg.usage?.slots?.via ?? "");
          cx.notify();
        } catch {}
      });
    read(cx);
  }

  command() {}

  /** Writes the cockpit config with one change (everything else in it is kept). */
  async write(change) {
    const { home } = await hub.install();
    const path = `${home}/.config/cockpit/config.json`;
    const before = await readTextFile(path);
    const cfg = before ? JSON.parse(before) : {};
    await writeTextFile(path, JSON.stringify(change(cfg), null, 2) + "\n", before);
  }

  /** One change to the config, kept on screen at once and written in the background. */
  save(cx, change) {
    cx.notify();
    cx.spawn(async () => this.write(change).catch((e) => this.fail(e)));
  }

  setAi(cx, key, value) {
    this.ai = { ...this.ai, [key]: value };
    const [group, field] = { auto: ["explain", "auto"], autoQuiz: ["explain", "auto_quiz"], difficulty: ["quiz", "difficulty"], count: ["quiz", "count"], gate: ["quiz", "gate"], pass: ["quiz", "pass"], reveal: ["quiz", "reveal"] }[key];
    this.save(cx, (cfg) => ({ ...cfg, [group]: { ...(cfg[group] ?? {}), [field]: value } }));
  }

  saveSlots(cx) {
    const url = this.slotsUrl.value().trim(), via = this.slotsVia.value().trim();
    this.save(cx, (cfg) => {
      const slots = { ...(cfg.usage?.slots ?? {}), url };
      if (via) slots.via = via;
      else delete slots.via;
      return { ...cfg, usage: { ...(cfg.usage ?? {}), slots } };
    });
  }

  fail(e) {
    notify({ title: "Could not save the setting", body: String(e?.message ?? e) });
  }

  setTab(cx, name, on) {
    const next = on ? [...this.spaces, name] : this.spaces.filter((s) => s !== name);
    this.spaces = next;
    cx.notify();
    cx.spawn(async () => this.write((cfg) => ({ ...cfg, spaces: next })).catch((e) => this.fail(e)));
  }

  setTitles(cx, on) {
    this.titles = on;
    cx.notify();
    cx.spawn(async () => this.write((cfg) => ({ ...cfg, titles: { ...(cfg.titles ?? {}), enabled: on } })).catch((e) => this.fail(e)));
  }

  /** Shows a section in the sidebar or takes it out of it (`sidebar.header` in the config, in the order shown). */
  setHeader(cx, name, on) {
    this.header = on ? [...this.header, name] : this.header.filter((x) => x !== name);
    this.saveHeader(cx);
  }

  moveHeader(cx, name, by) {
    const i = this.header.indexOf(name);
    const j = i + by;
    if (i < 0 || j < 0 || j >= this.header.length) return;
    const next = [...this.header];
    [next[i], next[j]] = [next[j], next[i]];
    this.header = next;
    this.saveHeader(cx);
  }

  setStatusItem(cx, name, on) {
    this.statusItems = on ? [...this.statusItems, name] : this.statusItems.filter((x) => x !== name);
    const items = this.statusItems;
    cx.notify();
    cx.spawn(async () => this.write((cfg) => ({ ...cfg, statusbar: { ...(cfg.statusbar ?? {}), items } })).catch((e) => this.fail(e)));
  }

  saveHeader(cx) {
    const header = this.header;
    cx.notify();
    cx.spawn(async () => this.write((cfg) => ({ ...cfg, sidebar: { ...(cfg.sidebar ?? {}), header } })).catch((e) => this.fail(e)));
  }

  render() {
    const k = tokens();
    const head = (text, hint) => v_flex().gap(2).child(div().text_size(TEXT.base).font_semibold().text_color(k.foreground).child(text)).child(div().text_size(TEXT.xs).text_color(k.dim).whitespace_normal().child(hint));
    const row = (id, label, hint, control) =>
      h_flex().id(id).gap(10).items_center().child(control).child(div().text_size(TEXT.sm).text_color(k.foreground).child(label)).child(div().flex_1().text_size(TEXT.xs).text_color(k.dim).child(hint ?? ""));
    // A setting with its words on the left and its control on the right.
    const line = (id, label, hint, control) =>
      h_flex().id(id).gap(16).py(8).items_center().border_b_1().border_color(alpha(k.border, 0.6))
        .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(TEXT.sm).text_color(k.foreground).child(label)).child(div().text_size(TEXT.xs).text_color(k.dim).whitespace_normal().child(hint ?? "")))
        .child(div().flex_none().child(control));
    const card = (id, title, hint, kids) => Card({ id, padding: 16, gap: 10, children: [head(title, hint), ...kids.filter(Boolean)] });
    const layout = () => [
      card("settings-tabs", "Tabs", "Which apps the sidebar's tab strip shows (applied within seconds)", [
        div().w_full().flex().flex_row().flex_wrap().gap(6).children(Object.entries(APPS).map(([name, a]) => div().w(220).child(row(`set-tab-${name}`, a.label, a.key, Checkbox(`set-tab-box-${name}`, { checked: this.spaces.includes(name), onClick: (_e, cx) => this.setTab(cx, name, !this.spaces.includes(name)) }))))),
      ]),
      card("settings-sections", "Sidebar sections", "Under \"Search or run\": a section that is off is gone from the sidebar, not folded; the arrows set the order", [
        v_flex().gap(6).children(
          [...this.header, ...SECTIONS.map(([n]) => n).filter((n) => !this.header.includes(n))].map((name) => {
            const on = this.header.includes(name);
            const i = this.header.indexOf(name);
            return h_flex().id(`set-sec-${name}`).gap(10).items_center()
              .child(Toggle(`set-sec-toggle-${name}`, on, (cx) => this.setHeader(cx, name, !on)))
              .child(div().flex_1().text_size(TEXT.sm).text_color(on ? k.foreground : k.dim).child(SECTIONS.find(([n]) => n === name)[1]))
              .when(on, (e) => e
                .child(Button(`set-sec-up-${name}`, { icon: "chevron-up", variant: "ghost", size: "icon-sm", disabled: i === 0, tooltip: "Move up", onClick: (_e, cx) => this.moveHeader(cx, name, -1) }))
                .child(Button(`set-sec-down-${name}`, { icon: "chevron-down", variant: "ghost", size: "icon-sm", disabled: i === this.header.length - 1, tooltip: "Move down", onClick: (_e, cx) => this.moveHeader(cx, name, 1) })));
          }),
        ),
      ]),
      card("settings-statusbar", "Bottom bar", "What shows between the agent counts and the agent's links, as far as the window is wide enough", [
        div().w_full().flex().flex_row().flex_wrap().gap(6).children([["agent", "Model", "and context"], ["mode", "Mode", ""], ["usage", "Usage limits", "5h and 7d"], ["machines", "Machine load", ""], ["omo", "OMO preset", "OpenCode"], ["tps", "Speed", "tok/s"]].map(([name, label, hint]) => div().w(220).child(row(`set-st-${name}`, label, hint, Checkbox(`set-st-box-${name}`, { checked: this.statusItems.includes(name), onClick: (_e, cx) => this.setStatusItem(cx, name, !this.statusItems.includes(name)) }))))),
      ]),
    ];
    const ai = () => [
      card("settings-explain", "Explaining pull requests", "Explain, Quiz me and Why? on a review comment ask this model of the LiteLLM gateway. A cheap, fast one is best: they run in the background.", [
        v_flex().gap(4).child(div().text_size(TEXT.xs).text_color(k.mutedFg).child("Model")).child(this.explainModel.element(k, "set-explain")),
        line("set-ai-auto", "Explain unasked", "An explanation for each pull request you open, and for each one with a finished review draft", Toggle("set-ai-auto-t", this.ai.auto, (cx) => this.setAi(cx, "auto", !this.ai.auto))),
        line("set-ai-quiz", "Quiz unasked", "A quiz for each pull request whose reviewing agent has finished its draft", Toggle("set-ai-quiz-t", this.ai.autoQuiz, (cx) => this.setAi(cx, "autoQuiz", !this.ai.autoQuiz))),
      ]),
      card("settings-quiz", "Quizzes", "How hard and how long a new quiz is; a quiz already written keeps its questions", [
        line("set-quiz-level", "Difficulty", { basics: "What it does and the common case", standard: "Concrete behaviour and why it is built this way", deep: "Edge cases, failure modes, ordering, callers: the code itself" }[this.ai.difficulty] ?? "", Tabs("set-quiz-level-t", { value: this.ai.difficulty, onChange: (v, cx) => this.setAi(cx, "difficulty", v), items: [{ value: "basics", label: "Basics" }, { value: "standard", label: "Standard" }, { value: "deep", label: "Deep" }] })),
        line("set-quiz-reveal", "Show the answers", this.ai.reveal === "end" ? "Only once every question is answered: no right or wrong, and no score, until then" : "Right after each answer, with why", Tabs("set-quiz-reveal-t", { value: this.ai.reveal, onChange: (v, cx) => this.setAi(cx, "reveal", v), items: [{ value: "each", label: "After each" }, { value: "end", label: "At the end" }] })),
        line("set-quiz-gate", "Pass the quiz before posting", this.ai.gate ? `Post review waits until you have answered every question and got at least ${this.ai.pass}% right. (Submitting the pending review on GitHub yourself still bypasses it.)` : "Off: the quiz is there to take, posting does not wait for it", Toggle("set-quiz-gate-t", this.ai.gate, (cx) => this.setAi(cx, "gate", !this.ai.gate))),
        this.ai.gate ? line("set-quiz-pass", "Pass mark", `${this.ai.pass}% of the questions right`, Tabs("set-quiz-pass-t", { value: String(this.ai.pass), onChange: (v, cx) => this.setAi(cx, "pass", Number(v)), items: [50, 60, 75, 90, 100].map((n) => ({ value: String(n), label: `${n}%` })) })) : null,
        line("set-quiz-count", "Questions", this.ai.count === "fit" ? "Fitted to the pull request: more for a bigger change and more agent comments (4 to 14)" : `Always ${this.ai.count}`, Tabs("set-quiz-count-t", { value: String(this.ai.count), onChange: (v, cx) => this.setAi(cx, "count", v === "fit" ? "fit" : Number(v)), items: [{ value: "fit", label: "Fit" }, ...[4, 6, 8, 10, 12].map((n) => ({ value: String(n), label: String(n) }))] })),
      ]),
      card("settings-titles", "Agent tabs", "An unnamed agent tab gets a few words for its task; a name you typed is never touched", [
        line("set-titles", "Name agent tabs", "The recap and title models are in the config file", Toggle("set-titles-toggle", this.titles, (cx) => this.setTitles(cx, !this.titles))),
      ]),
    ];
    const machines = () => [
      card("settings-slots", "Local model servers", "OpenCode's card on the Usage page shows how many requests each local GPU box serves at once, read from a sparkDash", [
        v_flex().gap(4).child(div().text_size(TEXT.xs).text_color(k.mutedFg).child("sparkDash address")).child(TextField(this.slotsUrl)),
        v_flex().gap(4).child(div().text_size(TEXT.xs).text_color(k.mutedFg).child("Asked from")).child(TextField(this.slotsVia)),
        div().text_size(TEXT.xs).text_color(k.dim).child("Saved when you leave a field."),
      ]),
    ];
    const file = () => [
      card("settings-file", "Everything else", "The recap and title models, the gateway, context limits, repositories and machines to watch live in the config file", [
        Button("settings-open-config", { label: "Open config.json", icon: "file-text", variant: "outline", size: "sm", onClick: (_e, cx) => cx.spawn(async () => openCode(`${(await hub.install()).home}/.config/cockpit/config.json`)) }),
      ]),
    ];
    const body = { layout, ai, machines, file }[this.section] ?? layout;
    return v_flex()
      .id("settings")
      .size_full()
      .bg(k.background)
      .text_color(k.foreground)
      .text_size(TEXT.base)
      .child(
        h_flex().flex_none().px(20).py(14).items_center().border_b_1().border_color(k.border)
          .child(div().flex_1().text_size(TEXT.lg ?? 16).font_semibold().child("Cockpit settings"))
          .child(Button("settings-done", { label: "Done", variant: "outline", size: "sm", kbd: "esc", onClick: () => closeOverlay(props().overlay) })),
      )
      .child(
        h_flex().flex_1().min_h(0)
          .child(
            v_flex().w(210).flex_none().h_full().p(10).gap(2).border_r_1().border_color(k.border).bg(k.muted)
              .children(NAV.map(([id, label, icon, hint]) => {
                const on = this.section === id;
                return h_flex().id(`set-nav-${id}`).gap(10).px(10).py(8).items_center().rounded(RADIUS.md).cursor_pointer()
                  .bg(on ? k.selected : alpha(k.muted, 0)).hover((x) => x.bg(on ? k.selected : k.accent))
                  .on_click((_e, cx) => ((this.section = id), cx.notify()))
                  .child(Icon(icon, { size: 15, color: on ? k.foreground : k.mutedFg }))
                  .child(v_flex().flex_1().min_w(0).child(div().text_size(TEXT.sm).font_medium().text_color(on ? k.foreground : k.mutedFg).child(label)).child(div().truncate().text_size(TEXT.xs).text_color(k.dim).child(hint)));
              })),
          )
          .child(v_flex().id("settings-scroll").flex_1().min_w(0).h_full().px(20).py(16).gap(16).overflow_y_scrollbar().children(body())),
      );
  }
}
