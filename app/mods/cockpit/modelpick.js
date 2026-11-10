// A model field with a searchable dropdown of the LiteLLM gateway's models (bin/cockpit-models.py): opening it (the field or its
// chevron) lists them all, the current one ticked first; typing narrows them; a click picks one. Nothing is preset: what you
// pick is remembered under `store` in localStorage and offered first next time.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { exec } from "herdr";
import * as hub from "./hub.js";
import { tokens, alpha, TEXT, RADIUS, TextField, Icon } from "./ui.js";

export class ModelPicker {
  /** Make it in `init` (it creates an input). */
  constructor(cx, { placeholder = "Search the gateway's models", store = null, onPick = null } = {}) {
    this.store = store;
    // Called with the model when one is clicked (a setting that saves it).
    this.onPick = onPick;
    this.models = [];
    this.open = false;
    let last = "";
    try {
      last = store ? localStorage.getItem(store) ?? "" : "";
    } catch {}
    this.input = InputState.new({ placeholder, value: last });
    // What the field held when the list opened: the list filters only once the text differs from it (you typed).
    this.openedWith = null;
    this.input.on("focus", (_e, cx) => this.show(cx));
    this.input.on("change", (_e, cx) => { if (!this.open) this.show(cx); else cx.notify(); });
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-models.py`], { timeout: 30000 });
        this.models = JSON.parse(r.stdout || "{}").models ?? [];
      } catch {}
      cx.notify();
    });
  }

  show(cx) {
    this.open = true;
    this.openedWith = this.value();
    cx.notify();
  }

  value() {
    return this.input.value().trim();
  }

  /** The field and, while it is open, the models that match. */
  element(k, id = "model") {
    const cur = this.value();
    const q = this.open && cur !== this.openedWith ? cur.toLowerCase() : "";
    const hits = this.models.filter((m) => !q || m.toLowerCase().includes(q));
    const shown = (q ? hits : [...hits.filter((m) => m === cur), ...hits.filter((m) => m !== cur)]).slice(0, 80);
    return v_flex()
      .id(`mp-${id}`)
      .w_full()
      .gap(6)
      .child(
        h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).child(TextField(this.input, { active: this.open })))
          .child(div().flex_none().text_size(TEXT.xs).text_color(k.dim).child(this.models.length ? `${this.models.length} models` : "reading…"))
          .child(div().id(`mp-${id}-toggle`).flex_none().size(26).flex().items_center().justify_center().rounded(RADIUS.sm).border_1().border_color(k.border).cursor_pointer().hover((x) => x.bg(k.accent)).tooltip("The gateway's models").on_click((_e, cx) => (this.open ? ((this.open = false), cx.notify()) : this.show(cx))).child(Icon(this.open ? "chevron-up" : "chevron-down", { size: 13, color: k.mutedFg }))),
      )
      .when(this.open && shown.length > 0, (e) =>
        e.child(
          v_flex()
            .id(`mp-${id}-list`)
            .max_h(200)
            .overflow_y_scrollbar()
            .rounded(RADIUS.md)
            .border_1()
            .border_color(k.border)
            .bg(k.popover)
            .children(
              shown.map((m) =>
                h_flex().id(`mp-${id}-${m}`).gap(8).px(10).py(6).items_center().cursor_pointer().text_size(TEXT.sm).font_family("JetBrains Mono").text_color(m === cur ? k.foreground : k.mutedFg).hover((x) => x.bg(k.accent)).child(div().w(14).flex_none().child(m === cur ? Icon("check", { size: 12, color: k.success }) : div())).child(div().flex_1().min_w(0).truncate().child(m)).on_click((_e, cx) => {
                  this.input.set_value(m);
                  this.open = false;
                  try {
                    if (this.store) localStorage.setItem(this.store, m);
                  } catch {}
                  this.onPick?.(m, cx);
                  cx.notify();
                }),
              ),
            ),
        ),
      );
  }
}

/** The gateway's model ids (one read of bin/cockpit-models.py). */
export async function gatewayModels() {
  try {
    const { home } = await hub.install();
    const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-models.py`], { timeout: 30000 });
    return JSON.parse(r.stdout || "{}").models ?? [];
  } catch {
    return [];
  }
}

/** The gateway's state: {ok, ms, count, base_url, error?}. */
export async function gatewayStatus() {
  try {
    const { home } = await hub.install();
    const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-models.py`, "--status"], { timeout: 20000 });
    return JSON.parse(r.stdout || "{}");
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
}
