// Eligible purchase quotes from the pinned ForeverDB snapshot, independent of Auctionator.
import type { VendorPriceQuote } from '../domain/pricing.js';
import type { ReferenceSource } from './records.js';
import type { QuestieSource } from './questiedb/tools.js';
import { zoneNameOf } from './zones.js';

export function vendorPrices(source: ReferenceSource | null, questie: QuestieSource | null, itemId: number, buyer: { faction: string | null; zoneName: string | null }): VendorPriceQuote[] {
  if (!source) return [];
  const faction = buyer.faction === 'alliance' ? 'A' : buyer.faction === 'horde' ? 'H' : null;
  const quotes: VendorPriceQuote[] = [];
  for (const offer of source.dataset.vendorOffers?.[String(itemId)] ?? []) {
    const npc = source.dataset.npcs?.[String(offer.npcId)];
    if (!npc || offer.priceCopper <= 0) continue;
    if (faction && npc.faction !== 'unknown' && npc.faction !== buyer.faction) continue;
    const friendly = questie?.get('npc', npc.id)?.fields.friendlyToFaction;
    if (faction && typeof friendly === 'string' && !friendly.includes(faction)) continue;
    quotes.push({
      datasetId: source.datasetId, recordKey: `items/${itemId}`, npcId: npc.id, npcName: npc.name,
      zoneName: zoneNameOf(npc.uiMapId), priceCopper: offer.priceCopper, stack: offer.stack,
      limitedStock: offer.limited, priceSource: offer.source,
      limitations: !faction || npc.faction === 'unknown' && typeof friendly !== 'string' ? ['vendor_faction_unverified: buyer or vendor faction is unknown'] : [],
    });
  }
  // Profession helper prices are per item and per faction; zero means unavailable.
  // They do not identify a vendor or prove unlimited stock.
  if (quotes.length === 0 && faction) {
    const record = source.dataset.records.prices?.[`vendor/${itemId}`];
    const fields = record?.fields;
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      const price = fields[faction === 'A' ? 'allianceUnitPriceCopper' : 'hordeUnitPriceCopper'];
      if (typeof price === 'number' && Number.isSafeInteger(price) && price > 0) quotes.push({
        datasetId: source.datasetId, recordKey: `vendor/${itemId}`, npcId: null, npcName: null, zoneName: null,
        priceCopper: price, stack: 1, limitedStock: null, priceSource: 'unknown',
        limitations: ['vendor_profession_guide: faction purchase quote; vendor identity and stock are unknown'],
      });
    }
  }
  // Prefer a local vendor when purchase costs are equal.
  return quotes.sort((a, b) => Number(b.zoneName === buyer.zoneName) - Number(a.zoneName === buyer.zoneName));
}
