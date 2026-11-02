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
  purchaseOptions?: readonly PurchaseOption[];
}

export interface VendorPriceQuote {
  datasetId: string;
  recordKey: string;
  npcId: number | null;
  npcName: string | null;
  zoneName: string | null;
  priceCopper: number;
  stack: number;
  limitedStock: number | null;
  priceSource: 'forever' | 'classic' | 'unknown';
  limitations: string[];
}

interface PurchaseOption {
  source: 'vendor' | 'auctionator';
  priceCopper: number;
  stack: number;
  vendor: VendorPriceQuote | null;
  observation: PriceObservation | null;
  limitations: string[];
}

export interface PurchaseSite {
  service: 'vendor' | 'auctioneer';
  npcId: number;
  npcName: string;
  zoneName: string | null;
  source: 'foreverdb' | 'questiedb';
  datasetId: string;
}

interface PurchaseContext {
  local?: boolean;
  purchaseAt?: PurchaseSite | null;
  priceBasis?: 'vendor_quote' | 'auction_observation' | 'reference_estimate' | 'unknown';
  /** A quote at another seller is an estimate, never a quote for purchaseAt. */
  referenceQuote?: VendorPriceQuote | null;
}

export interface PurchasePrice extends PurchaseContext {
  itemId: number;
  quantity: number;
  purchaseQuantity: number;
  source: 'vendor' | 'auctionator' | null;
  unitPriceCopper: number | null;
  totalCopper: number | null;
  vendor: VendorPriceQuote | null;
  observation: PriceObservation | null;
  limitations: string[];
  /** Best quote from the other purchase source; it is not included in the selected total. */
  alternatives: PurchaseAlternative[];
}

export interface PurchaseAlternative extends PurchaseContext {
  purchaseQuantity: number;
  source: 'vendor' | 'auctionator';
  unitPriceCopper: number;
  totalCopper: number;
  vendor: VendorPriceQuote | null;
  observation: PriceObservation | null;
  limitations: string[];
}

/** Compare purchase costs for the required quantity, including whole vendor packs. */
export function purchasePrice(itemId: number, quantity: number, choice: PriceChoice | undefined): PurchasePrice {
  const options: readonly PurchaseOption[] = choice?.purchaseOptions ?? (choice?.priceCopper != null
    ? [{ source: 'auctionator', priceCopper: choice.priceCopper, stack: 1, vendor: null, observation: choice.observation, limitations: choice.limitations }]
    : []);
  const bySource = new Map<PurchaseOption['source'], { option: PurchaseOption; cost: number }>();
  for (const option of options) {
    const cost = Math.ceil(quantity / option.stack) * option.priceCopper;
    const previous = bySource.get(option.source);
    if (!previous || cost < previous.cost) bySource.set(option.source, { option, cost });
  }
  // Keep one quote per source so a cheaper auction does not hide the known vendor price.
  const quotes: PurchaseAlternative[] = [...bySource.values()].map(({ option, cost }) => {
    const purchaseQuantity = Math.ceil(quantity / option.stack) * option.stack;
    const limitations = [...option.limitations];
    if (option.vendor) {
      const stock = option.vendor.limitedStock;
      limitations.push('vendor_price: static purchase quote; current stock, discounts and requirements are not confirmed');
      limitations.push(`vendor_price_source: item ${itemId}, NPC ${option.vendor.npcId ?? 'unknown'}, ${option.vendor.priceSource}`);
      if (stock !== null && stock > 0) {
        limitations.push(`vendor_limited_stock: item ${itemId}, NPC ${option.vendor.npcId ?? 'unknown'}, recorded stock ${stock}; current stock is unknown`);
        if (purchaseQuantity > stock) limitations.push(`vendor_restock_required: item ${itemId}, need ${purchaseQuantity}, recorded stock ${stock}; restocking is not confirmed`);
      }
    }
    return { purchaseQuantity, source: option.source, unitPriceCopper: option.priceCopper / option.stack, totalCopper: cost,
      vendor: option.vendor, observation: option.observation, limitations };
  });
  const best = quotes.reduce<PurchaseAlternative | null>((selected, quote) => selected === null || quote.totalCopper < selected.totalCopper ? quote : selected, null);
  return {
    itemId, quantity, purchaseQuantity: best?.purchaseQuantity ?? quantity, source: best?.source ?? null,
    unitPriceCopper: best?.unitPriceCopper ?? null, totalCopper: best?.totalCopper ?? null,
    vendor: best?.vendor ?? null, observation: best?.observation ?? null, limitations: best?.limitations ?? choice?.limitations ?? [],
    alternatives: quotes.filter((quote) => quote !== best),
  };
}

/** Vendor quotes are purchase prices; client sellPriceCopper is never an input. */
export function chooseCraftPrice(itemId: number, observations: readonly PriceObservation[], expectedMarket: string | null, vendors: readonly VendorPriceQuote[]): PriceChoice {
  const auction = choosePrice(itemId, observations, expectedMarket);
  const purchaseOptions: PurchaseOption[] = vendors
    .filter((v) => Number.isSafeInteger(v.priceCopper) && v.priceCopper > 0 && Number.isSafeInteger(v.stack) && v.stack > 0)
    .map((vendor) => ({ source: 'vendor', priceCopper: vendor.priceCopper, stack: vendor.stack, vendor, observation: null, limitations: vendor.limitations }));
  if (auction.priceCopper !== null) purchaseOptions.push({ source: 'auctionator', priceCopper: auction.priceCopper, stack: 1, vendor: null, observation: auction.observation, limitations: auction.limitations });
  const selected = purchasePrice(itemId, 1, { ...auction, purchaseOptions });
  return { itemId, priceCopper: selected.unitPriceCopper, observation: selected.source === 'auctionator' ? auction.observation : null, limitations: selected.limitations, purchaseOptions };
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
