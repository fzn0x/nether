// How published pages look (ADR 0076): the HTML export's column of text,
// light or dark as the reader prefers, with the site's name above it.
// Served as a file of its own, since a page's policy takes no style element.

const light = `
  --text: #1b1822; --muted: #5f5a66; --accent: #c43d18; --rule: #e3ddd3;
  --bg: #fffdf9; --code-bg: #f1ede6; --callout-bg: #c43d1812; --callout-rule: #c43d1847;
  --mark-bg: #f5d5478c;
  --code-keyword: #86288c; --code-string: #2f6b1f; --code-number: #9a4600;
  --code-title: #1d5c94; --code-type: #735000;`;

const dark = `
  --text: #ece8e1; --muted: #a39da8; --accent: #ff7a50; --rule: #2a2631;
  --bg: #131118; --code-bg: #1e1b24; --callout-bg: #ff7a501a; --callout-rule: #ff7a5047;
  --mark-bg: #f5d5474d;
  --code-keyword: #dda3f2; --code-string: #a8da8d; --code-number: #f4ae74;
  --code-title: #92c6ff; --code-type: #e8c47e;`;

/** The stylesheet every published page links to. */
export const siteStyle = `:root { color-scheme: light dark;${light} }
@media (prefers-color-scheme: dark) { :root {${dark} } }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
header.site { max-width: 46rem; margin: 0 auto; padding: 1.25rem 1.25rem 0; font-weight: 600; }
header.site a { color: var(--muted); text-decoration: none; }
header.site a:hover, header.site a:focus-visible { color: var(--accent); text-decoration: underline; }
nav.index ul { padding-inline-start: 1.2em; }
nav.index small { color: var(--muted); margin-inline-start: 0.4em; }
article { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
article :is(h1, h2, h3, h4, h5, h6) { margin: 1.6em 0 0.5em; line-height: 1.25; }
article h1 { font-size: 2rem; }
article h2 { font-size: 1.5rem; }
article h3 { font-size: 1.25rem; }
article > :first-child { margin-top: 0; }
article :is(p, h1, h2, h3, h4, h5, h6, li, blockquote, th, td) { unicode-bidi: plaintext; }
article p, article ul, article ol, article table, article pre { margin: 0 0 1em; }
article a { color: var(--accent); }
article .internal-link.unresolved { color: inherit; }
article .tag { color: var(--accent); }
article mark { background: var(--mark-bg); color: inherit; border-radius: 2px; }
article code { padding: 0.1em 0.3em; border-radius: 4px; background: var(--code-bg); font: 0.9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
article pre { padding: 0.8em 1em; overflow-x: auto; border-radius: 6px; background: var(--code-bg); }
article pre code { padding: 0; background: none; }
article blockquote { margin: 0 0 1em; padding-inline-start: 1em; border-inline-start: 3px solid var(--rule); color: var(--muted); }
article hr { border: 0; border-top: 1px solid var(--rule); margin: 2em 0; }
article table { border-collapse: collapse; display: block; overflow-x: auto; }
article th, article td { padding: 0.35em 0.7em; border: 1px solid var(--rule); }
article th { background: var(--code-bg); }
article img, article video, article svg { max-width: 100%; height: auto; }
article .tasks { padding-inline-start: 0.5em; list-style: none; }
article .task input { margin: 0; margin-inline-end: 0.4em; }
article .callout { margin: 0 0 1em; padding: 0.6em 1em; border: 1px solid var(--callout-rule); border-radius: 6px; background: var(--callout-bg); }
article .callout-title { margin: 0 0 0.4em; font-weight: 600; }
article details > summary { cursor: pointer; }
article .embed { margin: 0 0 1em; padding: 0.2em 1em; border-inline-start: 3px solid var(--rule); }
article .columns { display: flex; flex-wrap: wrap; gap: 1.5em; }
article .column { flex: 1; min-width: 12rem; }
article .file.missing, article .raw { color: var(--muted); }
article .hljs-keyword, article .hljs-selector-tag, article .hljs-built_in { color: var(--code-keyword); }
article .hljs-string, article .hljs-attr, article .hljs-regexp { color: var(--code-string); }
article .hljs-number, article .hljs-literal { color: var(--code-number); }
article .hljs-title, article .hljs-function { color: var(--code-title); }
article .hljs-type, article .hljs-class { color: var(--code-type); }
article .hljs-comment, article .hljs-quote { color: var(--muted); font-style: italic; }
`;
