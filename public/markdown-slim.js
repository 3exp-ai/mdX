// Minimal markdown language support — bypasses @codemirror/lang-markdown
// which pulls in lang-html, lang-css, lang-javascript, autocomplete (~170KB).
// We construct LanguageSupport directly from @lezer/markdown + @codemirror/language,
// and add custom extensions for: ==highlight==, $math$, $$block math$$, [^footnote].

import { parser, GFM } from "@lezer/markdown";
import {
  Language,
  LanguageSupport,
  defineLanguageFacet,
  languageDataProp,
  foldNodeProp,
  indentNodeProp,
} from "@codemirror/language";
import { NodeProp } from "@lezer/common";

const data = defineLanguageFacet({
  commentTokens: { block: { open: "<!--", close: "-->" } },
});

const headingLevelProp = new NodeProp();

function headingLevel(type) {
  const m = /^(?:ATX|Setext)Heading(\d)$/.exec(type.name);
  return m ? +m[1] : undefined;
}

// ==highlight== extension
const HighlightExt = {
  defineNodes: [{ name: "Highlight" }, { name: "HighlightMark" }],
  parseInline: [{
    name: "Highlight",
    parse(cx, next, pos) {
      if (next != 61 || cx.char(pos + 1) != 61) return -1;
      for (let i = pos + 2; i < cx.end - 1; i++) {
        if (cx.char(i) == 61 && cx.char(i + 1) == 61) {
          return cx.addElement(cx.elt("Highlight", pos, i + 2, [
            cx.elt("HighlightMark", pos, pos + 2),
            cx.elt("HighlightMark", i, i + 2),
          ]));
        }
      }
      return -1;
    },
    after: "Emphasis",
  }],
};

// $inline math$ extension
const InlineMathExt = {
  defineNodes: [{ name: "InlineMath" }, { name: "MathMark" }],
  parseInline: [{
    name: "InlineMath",
    parse(cx, next, pos) {
      if (next != 36) return -1;
      if (cx.char(pos + 1) == 36) return -1;
      // Avoid matching $ in prices like 5$
      if (pos > cx.offset) {
        const prev = cx.char(pos - 1);
        if (prev >= 48 && prev <= 57) return -1;
      }
      for (let i = pos + 1; i < cx.end; i++) {
        const ch = cx.char(i);
        if (ch == 36 && cx.char(i + 1) != 36 && i > pos + 1) {
          return cx.addElement(cx.elt("InlineMath", pos, i + 1, [
            cx.elt("MathMark", pos, pos + 1),
            cx.elt("MathMark", i, i + 1),
          ]));
        }
        if (ch == 10) return -1;
      }
      return -1;
    },
    after: "Emphasis",
  }],
};

// $$block math$$ extension
const BlockMathExt = {
  defineNodes: [{ name: "BlockMath", block: true }],
  parseBlock: [{
    name: "BlockMath",
    before: "FencedCode",
    parse(cx, line) {
      if (line.next != 36 || line.text.charCodeAt(line.pos + 1) != 36) return false;

      const from = cx.lineStart + line.pos;
      let delimLen = 2;
      for (let i = line.pos + 2; i < line.text.length && line.text.charCodeAt(i) == 36; i++) delimLen++;

      const marks = [cx.elt("MathMark", from, from + delimLen)];

      cx.nextLine();

      while (!cx.atEnd) {
        let closePos = line.pos;
        while (closePos < line.text.length && line.text.charCodeAt(closePos) == 36) closePos++;
        if (closePos - line.pos >= delimLen) {
          let rest = line.text.slice(closePos).trim();
          if (rest.length === 0) {
            marks.push(cx.elt("MathMark", cx.lineStart + line.pos, cx.lineStart + closePos));
            cx.nextLine();
            break;
          }
        }
        cx.nextLine();
      }

      cx.addNode(
        cx.buffer.writeElements(marks, -from).finish(cx.parser.getNodeType("BlockMath"), cx.prevLineEnd() - from),
        from
      );
      return true;
    },
  }],
};

// [^footnote] reference extension
const FootnoteRefExt = {
  defineNodes: [{ name: "FootnoteRef" }, { name: "FootnoteRefMark" }],
  parseInline: [{
    name: "FootnoteRef",
    parse(cx, next, pos) {
      if (next != 91 || cx.char(pos + 1) != 94) return -1;
      let i = pos + 2;
      while (i < cx.end) {
        const ch = cx.char(i);
        if (ch == 93 && i > pos + 2) {
          return cx.addElement(cx.elt("FootnoteRef", pos, i + 1, [
            cx.elt("FootnoteRefMark", pos, pos + 2),
            cx.elt("FootnoteRefMark", i, i + 1),
          ]));
        }
        if (ch == 91 || ch == 10) return -1;
        i++;
      }
      return -1;
    },
    before: "Link",
  }],
};

const configuredParser = parser.configure({
  props: [
    foldNodeProp.add((type) => {
      if (
        !type.is("Block") ||
        type.is("Document") ||
        headingLevel(type) != null ||
        type.name === "OrderedList" ||
        type.name === "BulletList"
      )
        return undefined;
      return (node, state) => ({
        from: state.doc.lineAt(node.from).to,
        to: node.to,
      });
    }),
    headingLevelProp.add(headingLevel),
    indentNodeProp.add({ Document: () => null }),
    languageDataProp.add({ Document: data }),
  ],
});

const gfmParser = configuredParser.configure([
  GFM,
  HighlightExt,
  InlineMathExt,
  BlockMathExt,
  FootnoteRefExt,
  {
    props: [
      foldNodeProp.add({
        Table: (node, state) => ({
          from: state.doc.lineAt(node.from).to,
          to: node.to,
        }),
      }),
    ],
  },
]);

export const markdownLanguage = new Language(data, gfmParser, [], "markdown");

export function markdownSlim() {
  return new LanguageSupport(markdownLanguage);
}
