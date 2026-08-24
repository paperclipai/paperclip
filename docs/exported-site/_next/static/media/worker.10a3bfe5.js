import { expose } from 'comlink';

let replacements, langMap;
let transformers;
let highlighter;
let hastToHtmlFn;
let codeStylingToThemeOrThemesFn;

const ready = (async () => {
  const [
    { createShikiHighlighter },
    { hastToHtml },
    {
      transformerNotationHighlight,
      transformerNotationFocus,
      transformerMetaHighlight,
      transformerNotationDiff,
    },
    { THEMES },
    {
      shikiColorReplacements,
      shikiLangMap,
      LINE_HIGHLIGHT_CLASS_NAME,
      LINE_FOCUS_CLASS_NAME,
      LINE_DIFF_ADD_CLASS_NAME,
      LINE_DIFF_REMOVE_CLASS_NAME,
    },
    { codeStylingToThemeOrThemes },
  ] = await Promise.all([
    import('./bundle.ts'),
    import('shiki/core'),
    import('@shikijs/transformers'),
    import('./themes.ts'),
    import('./constants.ts'),
    import('@mintlify/common'),
  ]);

  replacements = shikiColorReplacements;
  langMap = shikiLangMap;
  hastToHtmlFn = hastToHtml;
  codeStylingToThemeOrThemesFn = codeStylingToThemeOrThemes;
  highlighter = await createShikiHighlighter({ themes: THEMES, langs: [] });

  const matchAlgorithm = {
    matchAlgorithm: 'v3',
  };

  transformers = [
    transformerMetaHighlight({
      className: LINE_HIGHLIGHT_CLASS_NAME,
    }),
    transformerNotationHighlight({
      ...matchAlgorithm,
      classActiveLine: LINE_HIGHLIGHT_CLASS_NAME,
    }),
    transformerNotationFocus({
      ...matchAlgorithm,
      classActiveLine: LINE_FOCUS_CLASS_NAME,
    }),
    transformerNotationDiff({
      ...matchAlgorithm,
      classLineAdd: LINE_DIFF_ADD_CLASS_NAME,
      classLineRemove: LINE_DIFF_REMOVE_CLASS_NAME,
    }),
  ];
})();

function getShikiLanguage(lang) {
  const text = 'text';
  const n = Number(lang);
  const isStatus = !Number.isNaN(n) && Number.isFinite(n) && n > 99 && n < 600;
  return isStatus ? 'json' : lang ? (langMap[lang.toLowerCase()] ?? text) : text;
}

function getLanguageFromClassName(className, fallback) {
  const m = /language-(\w+)/.exec(className ?? '');
  return m ? (m[1] ?? 'text') : (fallback ?? 'text');
}

const loadedLangs = new Set();
const langLoads = new Map();

function loadLanguage(lang) {
  if (lang === 'text' || loadedLangs.has(lang)) return;
  let pending = langLoads.get(lang);
  if (!pending) {
    pending = highlighter.loadLanguage(lang).then(
      () => {
        loadedLangs.add(lang);
      },
      (err) => {
        langLoads.delete(lang);
        throw err;
      }
    );
    langLoads.set(lang, pending);
  }
  return pending;
}

function highlightSync(opts) {
  let lang =
    'language' in opts ? opts.language : getLanguageFromClassName(opts.className, opts.fileName);
  let html = undefined;
  if (lang) {
    const serializer =
      !!opts.opts?.highlightedLines?.length || !!opts.opts?.focusedLines?.length
        ? 'codeToHast'
        : 'codeToHtml';
    const code = opts.codeString.trim();
    const themeOrThemes = codeStylingToThemeOrThemesFn(opts.codeBlockTheme);
    html = highlighter[serializer](code, {
      lang: getShikiLanguage(lang),
      ...themeOrThemes,
      colorReplacements: { ...replacements },
      transformers: transformers,
      ...opts.opts,
    });
  }
  if (typeof html !== 'object') return html;
  const pre = html.children[0];
  if (pre?.type === 'element' && pre.tagName === 'pre') {
    const spanElements = pre.children[0].children.filter(
      (child) => child.type === 'element' && child.tagName === 'span'
    );
    spanElements.forEach((c, i) => {
      if (typeof c.properties.class === 'string') {
        if (opts.opts?.highlightedLines?.includes(i + 1)) {
          c.properties.class += ' line-highlight';
        }

        if (opts.opts?.focusedLines?.includes(i + 1)) {
          c.properties.class += ' line-focus';
        }
      } else if (Array.isArray(c.properties.class)) {
        if (opts.opts?.highlightedLines?.includes(i + 1)) {
          c.properties.class.push('line-highlight');
        }

        if (opts.opts?.focusedLines?.includes(i + 1)) {
          c.properties.class.push('line-focus');
        }
      }
    });
  }
  return hastToHtmlFn(html);
}

async function highlight(props) {
  await ready;
  const lang =
    'language' in props
      ? props.language
      : getLanguageFromClassName(props.className, props.fileName);
  await loadLanguage(getShikiLanguage(lang));
  return highlightSync(props);
}

expose({ highlight, ready });
