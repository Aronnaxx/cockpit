// A model field with a searchable dropdown of the LiteLLM gateway's models (bin/cockpit-models.py): type to narrow it, click one to
// pick it. Nothing is preset: what you pick is remembered under `store` in localStorage and offered first next time.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { exec } from "herdr";
import * as hub from "./hub.js";
import { tokens, alpha, TEXT, RADIUS, TextField } from "./ui.js";

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
    this.input.on("focus", (_e, cx) => ((this.open = true), cx.notify()));
    this.input.on("change", (_e, cx) => ((this.open = true), cx.notify()));
    cx.spawn(async (cx) => {
      try {
        const { home } = await hub.install();
        const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-models.py`], { timeout: 30000 });
        this.models = JSON.parse(r.stdout || "{}").models ?? [];
      } catch {}
      cx.notify();
    });
  }

  value() {
    return this.input.value().trim();
  }

  /** The field and, while it is open, the models that match. */
  element(k, id = "model") {
    const q = this.value().toLowerCase();
    const shown = this.models.filter((m) => !q || m.toLowerCase().includes(q)).slice(0, 40);
    return v_flex()
      .id(`mp-${id}`)
      .w_full()
      .gap(6)
      .child(h_flex().gap(8).items_center().child(TextField(this.input, { active: this.open })).child(div().flex_none().text_size(TEXT.xs).text_color(k.dim).child(this.models.length ? `${this.models.length} models` : "reading…")))
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
                div().id(`mp-${id}-${m}`).px(10).py(6).cursor_pointer().text_size(TEXT.sm).font_family("JetBrains Mono").text_color(m === this.value() ? k.foreground : k.mutedFg).hover((x) => x.bg(k.accent)).child(m).on_click((_e, cx) => {
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
