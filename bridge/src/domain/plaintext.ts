// The game chat shows plain text and cannot open web addresses. The prompt asks for plain
// text; models still write Markdown at times, so the bridge removes it before delivery.
// Text markers such as [[item:<refId>]] are not Markdown and stay unchanged.

const URL = String.raw`(?:https?:\/\/|www\.)[^\s<>()\[\]]+`;

const RULES: readonly (readonly [kind: string, pattern: RegExp, replacement: string])[] = [
  ['link', new RegExp(String.raw`(?<!\[)\[([^\[\]\n]+)\]\(\s*${URL}\s*\)`, 'g'), '$1'],
  ['url', new RegExp(String.raw`[ \t]*(?:\(\s*${URL}\s*\)|<${URL}>)`, 'g'), ''],
  ['url', new RegExp(URL, 'g'), ''],
  ['code', /^[ \t]*```.*$\n?/gm, ''],
  ['code', /`([^`\n]+)`/g, '$1'],
  ['heading', /^[ \t]*#{1,6}[ \t]+/gm, ''],
  ['bold', /\*\*([^*\n]+)\*\*/g, '$1'],
  ['bold', /__([^_\n]+)__/g, '$1'],
  ['bullet', /^([ \t]*)[*+][ \t]+/gm, '$1- '],
];

/** Text without Markdown and web addresses, and the kinds of Markdown removed. */
export function plainText(text: string): { text: string; removed: string[] } {
  const removed = new Set<string>();
  let out = text;
  for (const [kind, pattern, replacement] of RULES) {
    const next = out.replace(pattern, replacement);
    if (next !== out) removed.add(kind);
    out = next;
  }
  // Removed addresses leave doubled spaces and spaces before punctuation.
  if (removed.has('url')) out = out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.;:!?])/g, '$1').replace(/[ \t]+$/gm, '');
  return { text: out, removed: [...removed] };
}
