// Create deliveries: validate the contract, final Lua literal, packet limit
// and recipient. The sole pool writer handles publication.
import { Delivery, type DeliveryType, type RequestKey } from '../contracts.js';
import { randomId } from '../ids.js';
import type { Store } from '../storage/store.js';
import { luaByteLength, toLuaLiteral } from '../transport/lua.js';
import { MAX_DELIVERY_LUA_BYTES } from '../transport/packet.js';
import { DeliveryTooLarge } from './errors.js';

export interface DeliveryDraft {
  type: DeliveryType;
  request: RequestKey | null;
  body: unknown;
}

export interface CreateDelivery {
  characterKey: string;
  conversationId: string | null;
  replyId?: string | null;
  /** Recipient when the character has no current delivery session from HELLO. */
  fallbackTarget: string;
  now: number;
  draft: DeliveryDraft;
}

export interface PreparedDelivery {
  deliveryId: string;
  lua: string;
  bytes: number;
}

export class Outbox {
  constructor(private readonly store: Store) {}

  prepare(draft: DeliveryDraft): PreparedDelivery {
    const deliveryId = randomId();
    const delivery = Delivery.parse({ deliveryId, ...draft });
    const lua = toLuaLiteral(delivery);
    return { deliveryId, lua, bytes: luaByteLength(lua) };
  }

  fits(draft: DeliveryDraft): boolean {
    return this.prepare(draft).bytes <= MAX_DELIVERY_LUA_BYTES;
  }

  targetFor(characterKey: string, fallback: string): string {
    const state = this.store.getTransportState();
    return state.active_character_key === characterKey && state.active_delivery_session_id
      ? state.active_delivery_session_id
      : fallback;
  }

  create(input: CreateDelivery): string {
    const prepared = this.prepare(input.draft);
    if (prepared.bytes > MAX_DELIVERY_LUA_BYTES) throw new DeliveryTooLarge(prepared.bytes, MAX_DELIVERY_LUA_BYTES);
    const request = input.draft.request;
    this.store.insertDelivery({
      delivery_id: prepared.deliveryId,
      kind: input.draft.type,
      character_key: input.characterKey,
      conversation_id: input.conversationId,
      origin_session_id: request?.originSessionId ?? null,
      request_id: request?.requestId ?? null,
      reply_id: input.replyId ?? null,
      target_session_id: this.targetFor(input.characterKey, input.fallbackTarget),
      body_lua: prepared.lua,
      created_at: input.now,
    });
    return prepared.deliveryId;
  }
}
