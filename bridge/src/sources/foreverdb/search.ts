// The normalized reference records share the source-independent ranked index.
export { normalizeText, recordTexts, SEARCH_LIMITS, type SearchIndex, type MatchKind, type SearchPage, type SearchHit } from '../shared/index.js';
import { buildIndex as build, searchIndex as search, normalizeText } from '../shared/index.js';
import type { DecodedDataset } from './decode.js';
export function buildIndex(dataset: DecodedDataset) {
  const index = build(dataset);
  for (const entry of index.entries) {
    if (entry.type === 'recipes') {
      const recipe = dataset.recipes[entry.recordKey] as typeof dataset.recipes[string] & { name?: string };
      if (recipe?.name) entry.searchText += '\n' + normalizeText(recipe.name);
    }
    if (entry.type === 'bis') entry.searchText += '\n' + normalizeText(entry.recordKey.replaceAll('/', ' '));
  }
  return index;
}
export const searchIndex = search;
