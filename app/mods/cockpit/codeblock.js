// Code with the language's colours, read-only: the diff around a review comment, the lines a draft comment is on, a pull
// request's hunks and whole files. Each line is one row (its numbers, its sign, its text) that takes the height it needs:
// long lines wrap, nothing has a fixed size and nothing scrolls on its own, so the page around it scrolls as one.

import { div, list } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme } from "herdr";
import { tokens, alpha } from "./ui.js";

export const LINE = 18;
const MONO = "JetBrains Mono";

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

function palette() {
  const t = theme();
  return { comment: t.dim, string: t.ansi2, number: t.ansi1, keyword: t.ansi5, type: t.ansi3 };
}

const extOf = (path) => String(path ?? "").split(".").pop().toLowerCase();

/** The text of one line, coloured, wrapping between tokens (indentation kept). `ids`: false inside a lazy list. */
function text(id, line, ext, c, k, ids = true) {
  const parts = spans(line || " ", ext, c);
  return h_flex()
    .flex_1()
    .min_w(0)
    .flex_wrap()
    .text_size(11)
    .font_family(MONO)
    .text_color(k.foreground)
    .children(parts.map((s, j) => (ids ? div().id(`${id}-${j}`) : div()).whitespace_nowrap().text_color(s.color ?? k.foreground).child(s.text)));
}

/**
 * Rows of code: {num, old?, t?, text, mark?}. `num` is the line (the new side in a diff), `old` the old side's (shown when any row
 * has one), `t` "+", "-" or " " (a diff's sign and tint), `mark` a color the whole line is tinted with (a comment's range).
 * `onLine(num, event, cx)` makes a line's number the button that starts a comment there; `marked` (a Set of nums) puts a dot by it.
 */
export function CodeRows(id, rows, path, { onLine, marked } = {}) {
  const k = tokens();
  const c = palette();
  const ext = extOf(path);
  const diff = rows.some((r) => r.old != null || r.t === "-" || r.t === "+");
  const tint = (r) => (r.mark ? alpha(r.mark, 0.2) : r.t === "+" ? alpha(k.success, 0.14) : r.t === "-" ? alpha(k.destructive, 0.14) : null);
  return v_flex()
    .id(id)
    .w_full()
    .py(4)
    .rounded(6)
    .bg(alpha(k.muted, 0.7))
    .overflow_hidden()
    .children(
      rows.map((r, i) => {
        const dot = marked?.has(r.num);
        return h_flex()
          .id(`${id}-${i}`)
          .w_full()
          .items_start()
          .min_h(LINE)
          .bg(tint(r) ?? alpha(k.muted, 0))
          .when(Boolean(r.mark), (e) => e.border_l_2().border_color(r.mark))
          .when(diff, (e) => e.child(div().w(40).flex_none().px(4).h(LINE).flex().items_center().justify_end().text_size(10.5).font_family(MONO).text_color(k.dim).child(r.old != null ? String(r.old) : "")))
          .child(
            div()
              .id(`${id}-n${i}`)
              .w(46)
              .flex_none()
              .px(4)
              .h(LINE)
              .flex()
              .items_center()
              .justify_end()
              .gap(3)
              .text_size(10.5)
              .font_family(MONO)
              .text_color(dot || r.mark ? k.warning : k.dim)
              .when(Boolean(onLine && r.num != null), (e) => e.cursor_pointer().hover((x) => x.bg(alpha(k.ring, 0.25))).tooltip("Comment on this line (shift-click: to here)").on_click((ev, cx) => onLine(r.num, ev, cx)))
              .child(dot ? "●" : "")
              .child(r.num != null ? String(r.num) : ""),
          )
          .when(diff, (e) => e.child(div().w(14).flex_none().h(LINE).flex().items_center().justify_center().text_size(10.5).font_family(MONO).text_color(r.t === "+" ? k.success : r.t === "-" ? k.destructive : k.dim).child(r.t === "+" || r.t === "-" ? r.t : "")))
          .child(div().flex_1().min_w(0).pl(diff ? 2 : 10).pr(8).py(1).child(text(`${id}-t${i}`, r.text, ext, c, k)));
      }),
    );
}

/**
 * A whole file, drawn lazily (only the lines on screen): `changed` a Set of lines the PR adds (tinted green), `marks` line ->
 * color (a comment's range), `onLine(num, cx)` when a line is clicked. It scrolls itself: give it a bounded height.
 */
export function FileRows(id, lines, path, { changed = new Set(), marks = new Map(), onLine } = {}) {
  const k = tokens();
  const c = palette();
  const ext = extOf(path);
  const l = list(
    id,
    lines.length,
    (i) => String(i + 1),
    (i) => {
      const n = i + 1, mark = marks.get(n);
      return h_flex()
        .w_full()
        .items_start()
        .min_h(LINE)
        .bg(mark ? alpha(mark, 0.2) : changed.has(n) ? alpha(k.success, 0.14) : alpha(k.muted, 0))
        .child(div().w(52).flex_none().px(6).h(LINE).flex().items_center().justify_end().text_size(10.5).font_family(MONO).text_color(mark ? k.warning : k.dim).child(String(n)))
        .child(div().w(14).flex_none().h(LINE).flex().items_center().justify_center().text_size(10.5).font_family(MONO).text_color(k.success).child(changed.has(n) ? "+" : ""))
        .child(div().flex_1().min_w(0).pr(8).py(1).child(text("", lines[i], ext, c, k, false)));
    },
  );
  return onLine ? l.on_item_click((key, cx) => onLine(Number(key), cx)) : l;
}
