import { createHash, randomBytes } from 'node:crypto';
import type { Identity } from './contracts.js';

/** Bridge IDs: crypto.randomBytes(16) -> 32 lowercase hex digits. */
export function randomId(): string {
  return randomBytes(16).toString('hex');
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of the UTF-8 JSON array [serverNamespace, realm, playerGuid]. */
export function characterKeyOf(identity: Pick<Identity, 'serverNamespace' | 'realm' | 'playerGuid'>): string {
  return sha256Hex(JSON.stringify([identity.serverNamespace, identity.realm, identity.playerGuid]));
}
