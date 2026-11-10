// Code with the language's colours, read-only: the diff around a review comment and the lines a draft comment is on.
// Built on the editor's own highlighting (code.js uses it for files); a gutter of +/- or line numbers sits beside it.

import { div } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState } from "gpui-base";
import { settings, theme } from "herdr";
import { tokens, alpha } from "./ui.js";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", svelte: "html", vue: "html", htm: "html", md: "markdown", py: "python", rs: "rust", sh: "bash", zsh: "bash", ex: "elixir", exs: "elixir" };
const FONT = 11;
export const LINE = 18;

/** A highlighted, read-only view of `lines` (a file's extension picks the language). Make it in an event handler or a task, not in render. */
export function makeCode(lines, path) {
  const ext = String(path ?? "").split(".").pop().toLowerCase();
  const t = theme();
  const base = { readonly: true, line_numbers: false, folding: false, soft_wrap: false, font_family: settings().font_family, font_size: FONT, value: lines.join("\n"), syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi6 } };
  let state;
  try {
    state = EditorState.new({ ...base, language: LANG[ext] ?? ext });
  } catch {
    state = EditorState.new(base);
  }
  return { state, lines: lines.length };
}

/** The view: `gutter` is one label per line (a line number, or +, -, blank for a diff), `marks` the lines to tint (index -> color). */
export function CodeBlock(id, code, { gutter = [], marks = {} } = {}) {
  const k = tokens();
  return h_flex()
    .id(id)
    .w_full()
    .rounded(6)
    .bg(alpha(k.muted, 0.7))
    .overflow_hidden()
    .child(
      v_flex()
        .flex_none()
        .py(4)
        .children(code.state && gutter.map((g, i) => div().id(`${id}-g${i}`).h(LINE).px(8).min_w(32).flex().items_center().justify_end().text_size(10.5).font_family("JetBrains Mono").text_color(marks[i] ?? k.dim).bg(marks[i] ? alpha(marks[i], 0.14) : alpha(k.muted, 0)).child(g))),
    )
    .child(div().flex_1().min_w(0).h(code.lines * LINE + 8).py(4).child(Editor.new(code.state).size_full()));
}

/**
 * A hunk of a diff: `rows` are {t: "+" | "-" | " ", old, new} for each line of `code`; the new line's number is the button that
 * starts a comment on it (`onLine(newLine)`); `marked` is a Set of new lines that have a pending comment.
 */
export function DiffBlock(id, code, rows, { onLine, marked = new Set() } = {}) {
  const k = tokens();
  const tint = (t) => (t === "+" ? alpha(k.success, 0.16) : t === "-" ? alpha(k.destructive, 0.16) : null);
  return h_flex()
    .id(id)
    .w_full()
    .rounded(6)
    .bg(alpha(k.muted, 0.7))
    .overflow_hidden()
    .child(
      v_flex()
        .flex_none()
        .py(4)
        .children(
          rows.map((r, i) =>
            h_flex()
              .id(`${id}-r${i}`)
              .h(LINE)
              .bg(tint(r.t) ?? alpha(k.muted, 0))
              .child(div().w(38).flex_none().px(4).flex().items_center().justify_end().text_size(10.5).font_family("JetBrains Mono").text_color(k.dim).child(r.old ? String(r.old) : ""))
              .child(
                div()
                  .id(`${id}-n${i}`)
                  .w(44)
                  .flex_none()
                  .px(4)
                  .flex()
                  .items_center()
                  .justify_end()
                  .gap(3)
                  .text_size(10.5)
                  .font_family("JetBrains Mono")
                  .text_color(marked.has(r.new) ? k.warning : k.mutedFg)
                  .when(Boolean(r.new && onLine), (e) => e.cursor_pointer().hover((x) => x.bg(alpha(k.ring, 0.25))).tooltip("Comment on this line").on_click((_e, cx) => onLine(r.new, cx)))
                  .child(marked.has(r.new) ? "●" : "")
                  .child(r.new ? String(r.new) : ""),
              )
              .child(div().w(14).flex_none().flex().items_center().justify_center().text_size(10.5).font_family("JetBrains Mono").text_color(r.t === "+" ? k.success : r.t === "-" ? k.destructive : k.dim).child(r.t === " " ? "" : r.t)),
          ),
        ),
    )
    .child(div().flex_1().min_w(0).h(code.lines * LINE + 8).py(4).child(Editor.new(code.state).size_full()));
}

const KEYWORDS = new Set("fn let mut pub struct enum impl trait use mod match if else for while loop return async await move ref as in where const static type self Self crate super dyn unsafe def class import from with try except finally raise lambda None True False yield pass elif not and or is function var export default new this null undefined true false switch case break continue throw typeof message service rpc optional repeated required oneof map package syntax option rec inherit then".split(" "));

/** A line as colored spans [{text, color}]: comments, strings, numbers and keywords; a plain tokenizer, the same for every language. */
function spans(line, ext, c) {
  const out = [];
  const hash = ["py", "sh", "bash", "zsh", "nix", "toml", "yml", "yaml", "rb"].includes(ext);
  const re = /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|(\b\d[\d_.]*\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|(.)/g;
  let m;
  while ((m = re.exec(line))) {
    const [t, com, str, num, word] = m;
    if (com) out.push({ text: t, color: !hash && t.startsWith("#") ? null : c.comment });
    else if (str) out.push({ text: t, color: c.string });
    else if (num) out.push({ text: t, color: c.number });
    else if (word) out.push({ text: t, color: KEYWORDS.has(t) ? c.keyword : /^[A-Z]/.test(t) ? c.type : null });
    else out.push({ text: t, color: null });
  }
  return out;
}

/**
 * Code as rows that take the height they need (no fixed box): `rows` are {num, text, mark} (mark: a color to tint the line with). For
 * the lines a review comment is on, and the like. The language comes from the file's extension.
 */
export function CodeRows(id, rows, path) {
  const k = tokens();
  const t = theme();
  const c = { comment: t.dim, string: t.ansi2, number: t.ansi1, keyword: t.ansi5, type: t.ansi3 };
  const ext = String(path ?? "").split(".").pop().toLowerCase();
  return v_flex()
    .id(id)
    .w_full()
    .py(4)
    .rounded(6)
    .bg(alpha(k.muted, 0.7))
    .overflow_x_scrollbar()
    .children(
      rows.map((r, i) =>
        h_flex()
          .id(`${id}-${i}`)
          .gap(10)
          .px(8)
          .min_h(LINE)
          .items_center()
          .bg(r.mark ? alpha(r.mark, 0.18) : alpha(k.muted, 0))
          .child(div().w(38).flex_none().flex().justify_end().text_size(10.5).font_family("JetBrains Mono").text_color(r.mark ? k.foreground : k.dim).child(r.num == null ? "" : String(r.num)))
          .child(h_flex().whitespace_nowrap().text_size(11).font_family("JetBrains Mono").text_color(k.foreground).children(spans(r.text || " ", ext, c).map((s, j) => div().id(`${id}-${i}-${j}`).whitespace_pre().text_color(s.color ?? k.foreground).child(s.text)))),
      ),
    );
}
