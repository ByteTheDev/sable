/**
 * The heavy half of syntax highlighting. Loaded on demand by lib/highlight.ts so the
 * first paint never pays for it: shiki's core, the JS regex engine, one theme built
 * from the design tokens and only the grammars a transcript actually uses.
 */
import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemeRegistrationRaw } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { HlLines, HlToken } from './highlight';

type LangModule = { default: LanguageRegistration[] };

const LOADERS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  http: () => import('shiki/langs/http.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  make: () => import('shiki/langs/make.mjs'),
};

/**
 * One theme, written against CSS variables (components/code.css defines them from the
 * design tokens). Three quiet hues over neutrals: keywords cool, strings warm,
 * constants violet. Everything else is a shade of the text colour.
 */
const THEME: ThemeRegistrationRaw = {
  name: 'sable',
  type: 'dark',
  colors: { 'editor.foreground': 'var(--syn-fg)', 'editor.background': '#00000000' },
  settings: [
    { settings: { foreground: 'var(--syn-fg)' } },
    { scope: ['comment', 'punctuation.definition.comment', 'string.comment'], settings: { foreground: 'var(--syn-comment)', fontStyle: 'italic' } },
    {
      scope: ['punctuation', 'meta.brace', 'keyword.operator', 'storage.type.function.arrow', 'punctuation.definition.tag', 'meta.embedded.line punctuation.section.embedded'],
      settings: { foreground: 'var(--syn-punct)' },
    },
    {
      scope: [
        'keyword',
        'storage',
        'storage.type',
        'storage.modifier',
        'keyword.control',
        'keyword.operator.new',
        'keyword.operator.expression',
        'keyword.operator.logical.python',
        'keyword.operator.wordlike',
        'keyword.operator.word',
        'keyword.other',
        'variable.language',
        'entity.name.tag',
        'meta.diff.range',
        'punctuation.definition.heading',
        'support.type.builtin',
        'keyword.other.unit',
      ],
      settings: { foreground: 'var(--syn-keyword)' },
    },
    {
      scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string', 'markup.inline.raw', 'markup.raw', 'string.unquoted.plain.out.yaml', 'meta.attribute-selector'],
      settings: { foreground: 'var(--syn-string)' },
    },
    {
      scope: [
        'constant',
        'constant.numeric',
        'constant.language',
        'constant.character',
        'constant.other',
        'support.constant',
        'variable.other.constant',
        'variable.other.enummember',
        'string.regexp',
        'constant.character.escape',
        'keyword.other.unit',
        'entity.other.attribute-name.pseudo-class',
      ],
      settings: { foreground: 'var(--syn-const)' },
    },
    {
      scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function', 'entity.name.command', 'markup.heading', 'entity.name.section'],
      settings: { foreground: 'var(--syn-fn)' },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'entity.name.namespace',
        'entity.other.inherited-class',
        'support.type',
        'support.class',
        'entity.other.attribute-name',
        'support.type.property-name',
        'entity.name.tag.yaml',
        'support.type.property-name.json',
        'variable.other.env',
        'entity.name.header',
      ],
      settings: { foreground: 'var(--syn-type)' },
    },
    { scope: ['variable.parameter', 'variable.other.readwrite', 'variable.other.object', 'variable.other.property', 'meta.object-literal.key'], settings: { foreground: 'var(--syn-fg)' } },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.underline.link', 'string.other.link'], settings: { foreground: 'var(--syn-keyword)' } },
    { scope: ['markup.inserted', 'punctuation.definition.inserted'], settings: { foreground: 'var(--add)' } },
    { scope: ['markup.deleted', 'punctuation.definition.deleted'], settings: { foreground: 'var(--del)' } },
    { scope: ['markup.changed'], settings: { foreground: 'var(--amber)' } },
    { scope: ['invalid', 'invalid.illegal'], settings: { foreground: 'var(--del)' } },
  ],
};

let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<boolean>>();

function core() {
  return (highlighter ??= createHighlighterCore({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) }));
}

function ensureLang(lang: string): Promise<boolean> {
  let p = loaded.get(lang);
  if (!p) {
    p = (async () => {
      const load = LOADERS[lang];
      if (!load) return false;
      try {
        const [hl, mod] = await Promise.all([core(), load()]);
        await hl.loadLanguage(...mod.default);
        return true;
      } catch {
        return false;
      }
    })();
    loaded.set(lang, p);
  }
  return p;
}

const FG = 'var(--syn-fg)';

/** Tokenizes `code`; adjacent tokens with the same style are merged to keep the DOM small. */
export async function tokenize(code: string, lang: string): Promise<HlLines | null> {
  if (!(await ensureLang(lang))) return null;
  const hl = await core();
  try {
    const lines = hl.codeToTokensBase(code, { lang, theme: 'sable' });
    return lines.map((line) => {
      const out: HlToken[] = [];
      for (const t of line) {
        const color = !t.color || t.color === FG ? undefined : t.color;
        const style = t.fontStyle && t.fontStyle > 0 ? t.fontStyle : undefined;
        const last = out[out.length - 1];
        // Whitespace carries no colour, so it can ride along with whatever came before.
        if (last && ((last.color === color && last.style === style) || !t.content.trim())) last.content += t.content;
        else out.push({ content: t.content, color, style });
      }
      return out;
    });
  } catch {
    return null;
  }
}
