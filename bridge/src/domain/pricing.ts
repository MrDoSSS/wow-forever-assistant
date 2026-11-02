// Auctionator price semantics: latest known observation, copper per
// unit; neither stock nor a purchase guarantee. Allow unknown markets with
// market_unverified; exclude observations from a known different market.
// tool-channel.ts supplies the expected market: the current key for a single-faction account.
import type { PriceObservation } from '../contracts.js';

export interface PriceChoice {
  itemId: number;
  priceCopper: number | null;
  observation: PriceObservation | null;
  limitations: string[];
}

/**
 * Item price from observations in arrival order; use the latest matching one.
 * expectedMarket is the character's market if known; null means unverified.
 */
export function choosePrice(itemId: number, observations: readonly PriceObservation[], expectedMarket: string | null): PriceChoice {
  const forItem = observations.filter((o) => o.item.itemId === itemId);
  const priced = forItem.filter((o) => o.priceCopper !== null && o.priceCopper > 0);
  const limitations: string[] = [];
  if (forItem.length > 0 && priced.length === 0) {
    const reason = forItem.at(-1)?.unavailableReason ?? 'no_price';
    return { itemId, priceCopper: null, observation: null, limitations: [`price_unavailable:${reason}`] };
  }
  let usable = priced;
  if (expectedMarket !== null) {
    usable = priced.filter((o) => o.marketKey === expectedMarket);
    if (usable.length === 0 && priced.length > 0) {
      return { itemId, priceCopper: null, observation: null, limitations: ['other_market_only'] };
    }
  } else if (priced.length > 0) {
    limitations.push('market_unverified');
  }
  const observation = usable.at(-1) ?? null;
  if (!observation) return { itemId, priceCopper: null, observation: null, limitations: ['price_unavailable:no_observation'] };
  if (observation.exactness === 'fallback') limitations.push('price_fallback_variant');
  if (observation.exactness === 'unknown') limitations.push('price_exactness_unknown');
  if (observation.ageDays === null) limitations.push('price_age_unknown');
  return { itemId, priceCopper: observation.priceCopper, observation, limitations };
}
