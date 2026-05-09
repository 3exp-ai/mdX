// Minimal markdown language support — bypasses @codemirror/lang-markdown
// which pulls in lang-html, lang-css, lang-javascript, autocomplete (~170KB).
// We construct LanguageSupport directly from @lezer/markdown + @codemirror/language.

import { parser, GFM } from "./vendor/@lezer/markdown@^1.0.0.js";
import {
  Language,
  LanguageSupport,
  defineLanguageFacet,
  languageDataProp,
  foldNodeProp,
  indentNodeProp,
} from "./vendor/@codemirror/language.js";
import { NodeProp } from "./vendor/@lezer/common@^1.0.0.js";

const data = defineLanguageFacet({
  commentTokens: { block: { open: "<!--", close: "-->" } },
});

const headingLevelProp = new NodeProp();

function headingLevel(type) {
  const m = /^(?:ATX|Setext)Heading(\d)$/.exec(type.name);
  return m ? +m[1] : undefined;
}

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
