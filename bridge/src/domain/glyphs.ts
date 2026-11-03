// Reply text must fit the addon font (addon/ForeverAssistant/Fonts/NotoSans-Regular.ttf).
// The client cannot draw missing glyphs and displays a replacement box. Convert common
// symbols to ASCII and remove other unsupported characters. The font test
// (tests/domain.test.ts) verifies the table against the font file; update it if the font changes.
// Korean and Chinese clients draw the chat with the client's own font (UI/Theme.lua),
// which adds their script.

/** Code point ranges with glyphs, excluding controls; newline and tab are allowed separately. */
export const FONT_RANGES: readonly (readonly [number, number])[] = [
  [0x0020, 0x007e], [0x00a0, 0x0377], [0x037a, 0x037f], [0x0384, 0x038a], [0x038c, 0x038c], [0x038e, 0x03a1],
  [0x03a3, 0x03e1], [0x03f0, 0x052f], [0x1ab0, 0x1ac0], [0x1c80, 0x1c88], [0x1d00, 0x1df9], [0x1dfb, 0x1f15],
  [0x1f18, 0x1f1d], [0x1f20, 0x1f45], [0x1f48, 0x1f4d], [0x1f50, 0x1f57], [0x1f59, 0x1f59], [0x1f5b, 0x1f5b],
  [0x1f5d, 0x1f5d], [0x1f5f, 0x1f7d], [0x1f80, 0x1fb4], [0x1fb6, 0x1fc4], [0x1fc6, 0x1fd3], [0x1fd6, 0x1fdb],
  [0x1fdd, 0x1fef], [0x1ff2, 0x1ff4], [0x1ff6, 0x1ffe], [0x2000, 0x2064], [0x2066, 0x2071], [0x2074, 0x208e],
  [0x2090, 0x209c], [0x20a0, 0x20bf], [0x20f0, 0x20f0], [0x2100, 0x215f], [0x2184, 0x2184], [0x2189, 0x2189],
  [0x25cc, 0x25cc], [0x2c60, 0x2c7f], [0x2de0, 0x2e52], [0xa640, 0xa69f], [0xa700, 0xa7bf], [0xa7c2, 0xa7ca],
  [0xa7f5, 0xa7ff], [0xa92e, 0xa92e], [0xab30, 0xab6b], [0xfb00, 0xfb06], [0xfe00, 0xfe00], [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff], [0xfffc, 0xfffd],
];

/** ASCII replacements for symbols frequently produced by the model. */
const REPLACEMENTS: Record<string, string> = {
  '→': '->', '⟶': '->', '➜': '->', '➔': '->', '⇒': '=>', '⟹': '=>',
  '←': '<-', '⟵': '<-', '⇐': '<=', '↔': '<->', '⇔': '<=>',
  '↑': '^', '↓': 'v',
  '−': '-', '≈': '~', '≤': '<=', '≥': '>=', '≠': '!=', '±': '+/-', '∞': 'inf',
  '✓': '+', '✔': '+', '✅': '+', '✗': 'x', '✘': 'x', '❌': 'x',
  '★': '*', '☆': '*', '⭐': '*', '▪': '-', '▸': '-', '►': '-', '▶': '-',
};

const CJK: readonly (readonly [number, number])[] = [
  [0x3000, 0x30ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0xff00, 0xffef],
];
const HANGUL: readonly (readonly [number, number])[] = [[0x1100, 0x11ff], [0x3130, 0x318f], [0xac00, 0xd7a3]];

/** Scripts added by the client font in locales whose chat uses it (keep in sync with UI/Theme.lua). */
const CLIENT_FONT_SCRIPTS: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  koKR: [...HANGUL, ...CJK],
  zhCN: CJK,
  zhTW: CJK,
};

function inFont(code: number, locale: string): boolean {
  if (code === 0x0a || code === 0x09) return true;
  if (CLIENT_FONT_SCRIPTS[locale]?.some(([start, end]) => code >= start && code <= end)) return true;
  let lo = 0;
  let hi = FONT_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = FONT_RANGES[mid]!;
    if (code < start) hi = mid - 1;
    else if (code > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Text the chat font of a client locale can display in full. */
export function fitFont(text: string, locale = 'enUS'): string {
  let out = '';
  for (const char of text) {
    if (inFont(char.codePointAt(0)!, locale)) out += char;
    else if (char in REPLACEMENTS) out += REPLACEMENTS[char];
  }
  return out;
}
