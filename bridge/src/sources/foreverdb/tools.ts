// Public tool API over the normalized ForeverDB snapshot. Arithmetic remains
// source independent; shared mechanics handle the normalized reference records.
import { GameDataSource } from '../shared/reference.js';
import type { DecodedDataset, VendorOffer } from './decode.js';
import type { DatasetType, DatasetRecord } from './decode.js';
import type { LiteralValue } from './parse.js';
import type { SearchIndex } from './search.js';
export type { ToolOutcome, ToolStatus, ItemInfo, SourceStatus } from '../shared/reference.js';
export class ForeverDBSource extends GameDataSource {
  declare readonly dataset: DecodedDataset;
  constructor(dataset: DecodedDataset, index: SearchIndex) { super(dataset, index); }
  get sourceKind(): 'foreverdb' { return this.dataset.sourceKind ?? 'foreverdb'; }
  override getGameRecord(type: DatasetType, recordKey: string) {
    // Select the level before the shared response-size limiter truncates candidates.
    // Otherwise the highest-level items could hide every usable low-level choice.
    const selected = type === 'bis' ? /^(.*)\/level\/([1-9]\d?)$/.exec(recordKey) : null;
    if (!selected) return super.getGameRecord(type, recordKey);
    const level = Number(selected[2]);
    const result = super.getGameRecord(type, selected[1]!);
    if (level > 60 || !result.data) return { ...result, status: 'not_found' as const, data: null };
    const fields = result.data.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Array.isArray(fields.candidates)) return { ...result, status: 'not_found' as const, data: null };
    const candidates = fields.candidates.filter((v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.minLevel === 'number' && v.minLevel <= level);
    const data: DatasetRecord = { ...result.data, recordKey, fields: { ...fields, requestedLevel: level, candidates } as LiteralValue };
    return { ...result, data };
  }
  override getItem(itemId: number) {
    const result = super.getItem(itemId);
    const vendorOffers: VendorOffer[] = this.dataset.vendorOffers?.[String(itemId)] ?? [];
    return result.data ? { ...result, data: { ...result.data, ...this.dataset.itemFacts?.[String(itemId)], vendorOffers } } : result;
  }
  override status() {
    const result = super.status();
    return { ...result, data: result.data ? { ...result.data,
      attribution: this.dataset.attribution ?? null,
      limitations: [...result.data.limitations, ...this.dataset.limitations ?? []],
    } : null };
  }
}
