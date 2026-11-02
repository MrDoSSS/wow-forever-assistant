// Build Inbox.lua from immutable delivery literals. The file contains
// only an assignment to the ForeverAssistantInbox table.
import { LIMITS, type MessageKey } from '../contracts.js';
import { luaByteLength, toLuaLiteral } from './lua.js';

export interface InboxHeader {
  publicationRevision: number;
  targetCharacterKey: string;
  targetDeliverySessionId: string;
  acceptedMessageKeys: MessageKey[];
}

export function buildInboxLua(header: InboxHeader, deliveryLiterals: readonly string[]): string {
  const head = toLuaLiteral({
    version: 1,
    publicationRevision: header.publicationRevision,
    targetCharacterKey: header.targetCharacterKey,
    targetDeliverySessionId: header.targetDeliverySessionId,
    acceptedMessageKeys: header.acceptedMessageKeys,
  });
  return `ForeverAssistantInbox=${head.slice(0, -1)},deliveries={${deliveryLiterals.join(',')}}}\n`;
}

function worstCaseHeader(): InboxHeader {
  const hex32 = 'f'.repeat(32);
  return {
    publicationRevision: Number.MAX_SAFE_INTEGER,
    targetCharacterKey: 'f'.repeat(64),
    targetDeliverySessionId: hex32,
    acceptedMessageKeys: Array.from({ length: LIMITS.acceptedMessageKeys }, () => ({
      originSessionId: hex32,
      messageSequence: 4294967295,
    })),
  };
}

/** Largest delivery literal guaranteed to fit in a packet. */
export const MAX_DELIVERY_LUA_BYTES = LIMITS.inboxLuaBytes - luaByteLength(buildInboxLua(worstCaseHeader(), ['']));
