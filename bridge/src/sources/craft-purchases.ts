// Craft shopping favors the consumer's local services. Price coverage must not choose the buyer.
import type { PriceObservation } from '../contracts.js';
import type { PlanPurchase } from '../domain/craft-plan.js';
import { chooseCraftPrice, purchasePrice, type PurchaseAlternative, type PurchasePrice, type PurchaseSite } from '../domain/pricing.js';
import type { ReferenceSource } from './records.js';
import type { QuestieSource, WorldCharacter } from './questiedb/tools.js';
import { vendorPrices } from './pricing.js';
import { findServices, type ServicePoint } from './services.js';

export interface PurchaseCharacter extends WorldCharacter { name: string }

function quotedOptions(price: PurchasePrice): PurchaseAlternative[] {
  const options = [...price.alternatives];
  if (price.source !== null && price.unitPriceCopper !== null && price.totalCopper !== null) options.unshift({
    source: price.source, purchaseQuantity: price.purchaseQuantity, unitPriceCopper: price.unitPriceCopper,
    totalCopper: price.totalCopper, vendor: price.vendor, observation: price.observation, limitations: price.limitations,
  });
  return options;
}

export function createCraftPurchaser(input: {
  source: ReferenceSource | null;
  questie: QuestieSource | null;
  observations: readonly PriceObservation[];
  expectedMarket: string | null;
  current: PurchaseCharacter;
  characters: readonly PurchaseCharacter[];
}): (itemId: number, quantity: number, preferredBuyer: string) => PlanPurchase {
  const { source, questie, current } = input;
  const characters = new Map(input.characters.map((character) => [character.name, character]));
  characters.set(current.name, current);
  const prepare = (itemId: number, name: string) => {
    const who = characters.get(name) ?? { name, faction: null, zoneName: null, uiMapId: null, x: null, y: null };
    // Auction observations from a known opposing faction are not prices for this buyer.
    const sameMarket = !who.faction || !current.faction || who.faction === current.faction;
    const observations = sameMarket ? input.observations : [];
    const quotes = vendorPrices(source, questie, itemId, who);
    const prices = chooseCraftPrice(itemId, observations, sameMarket ? input.expectedMarket : null, quotes);
    const services = (service: 'vendor' | 'auctioneer') => who.zoneName === null ? [] : findServices(source, questie, {
      service, itemId: service === 'vendor' ? itemId : null, zoneName: who.zoneName, profession: null, classToken: null,
    }, who).services;
    return { who, quotes, prices, sites: [...services('vendor'), ...services('auctioneer')] };
  };
  const cache = new Map<string, ReturnType<typeof prepare>>();
  const context = (itemId: number, name: string) => {
    const key = `${name}|${itemId}`;
    let result = cache.get(key);
    if (!result) { result = prepare(itemId, name); cache.set(key, result); }
    return result;
  };
  const purchaseSite = (point: ServicePoint): PurchaseSite => ({
    service: point.service as 'vendor' | 'auctioneer', npcId: point.id, npcName: point.title, zoneName: point.zoneName,
    source: point.source, datasetId: point.sources.find((record) => record.source === point.source)!.datasetId,
  });

  return (itemId, quantity, preferredBuyer) => {
    let ctx = context(itemId, preferredBuyer);
    const limitations: string[] = [];
    // Only use another purchaser when the world reference has no local service for the consumer.
    // Missing faction, zone or vendor price alone never makes the current character the buyer.
    if (questie && ctx.who.zoneName !== null && !ctx.sites.length && preferredBuyer !== current.name) {
      const fallback = context(itemId, current.name);
      if (fallback.sites.length) {
        limitations.push(`purchase_elsewhere: no local vendor or auctioneer found in the reference for ${preferredBuyer}; ${current.name} buys and sends item ${itemId}`);
        ctx = fallback;
      }
    }
    const bestKnown = purchasePrice(itemId, quantity, ctx.prices);
    const options = quotedOptions(bestKnown);
    const sites = [...ctx.sites].sort((a, b) => {
      const insufficient = (point: ServicePoint) => point.limitedStock !== undefined && point.limitedStock > 0 && point.limitedStock < quantity ? 1 : 0;
      return insufficient(a) - insufficient(b) || (a.distanceOnMap ?? Infinity) - (b.distanceOnMap ?? Infinity) ||
        Number(b.service === 'vendor') - Number(a.service === 'vendor');
    });
    const site = sites[0];
    let selected: PurchasePrice;
    if (site?.service === 'vendor') {
      const exact = ctx.quotes.filter((quote) => quote.npcId === site.id);
      if (exact.length) {
        selected = { ...purchasePrice(itemId, quantity, chooseCraftPrice(itemId, [], null, exact)), priceBasis: 'vendor_quote' };
      } else {
        const reference = options.find((option) => option.source === 'vendor');
        selected = {
          itemId, quantity, purchaseQuantity: quantity, source: 'vendor', vendor: null, observation: null,
          unitPriceCopper: reference?.unitPriceCopper ?? null,
          totalCopper: reference ? Math.ceil(reference.unitPriceCopper * quantity) : null,
          priceBasis: reference ? 'reference_estimate' : 'unknown', referenceQuote: reference?.vendor ?? null,
          limitations: [reference
            ? `vendor_price_estimate: item ${itemId} at ${site.title}; estimated from ${reference.vendor?.npcName ?? 'the faction profession guide'}, not a quote for this seller; pack size and stock are unknown`
            : `vendor_price_unknown: item ${itemId} at ${site.title}; seller relationship is known but purchase price, pack size and stock are unknown`],
          alternatives: [],
        };
      }
    } else if (site?.service === 'auctioneer') {
      const auction = options.find((option) => option.source === 'auctionator');
      selected = { itemId, quantity, purchaseQuantity: quantity, source: 'auctionator', vendor: null,
        unitPriceCopper: auction?.unitPriceCopper ?? null, totalCopper: auction?.totalCopper ?? null,
        observation: auction?.observation ?? null, limitations: auction?.limitations ?? ['auction_price_unknown'],
        priceBasis: auction ? 'auction_observation' : 'unknown', alternatives: [] };
    } else {
      selected = { ...bestKnown, priceBasis: bestKnown.vendor ? 'vendor_quote' : bestKnown.observation ? 'auction_observation' : 'unknown' };
      if (ctx.who.zoneName) limitations.push(`local_purchase_not_found: item ${itemId} for ${ctx.who.name}; local availability is not confirmed by the references`);
    }
    const vendor = selected.vendor;
    const remoteVendor = !site && vendor && vendor.npcId !== null ? {
      service: 'vendor' as const, npcId: vendor.npcId, npcName: vendor.npcName ?? `NPC ${vendor.npcId}`,
      zoneName: vendor.zoneName, source: 'foreverdb' as const, datasetId: vendor.datasetId,
    } : null;
    return {
      ...selected, buyer: ctx.who.name, local: !!site, purchaseAt: site ? purchaseSite(site) : remoteVendor,
      alternatives: options.filter((option) => option.source !== selected.source || option.vendor?.npcId !== selected.vendor?.npcId || option.vendor?.recordKey !== selected.vendor?.recordKey),
      limitations: [...selected.limitations, ...limitations],
    };
  };
}
