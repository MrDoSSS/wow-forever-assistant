// Source-independent normalized game reference records.
import type { DATASET_TYPES } from '../../contracts.js';
import type { LiteralValue } from './lua.js';
export type DatasetType = (typeof DATASET_TYPES)[number];

export interface Reagent {
  itemId: number;
  count: number;
}

export interface RecipeRecord {
  spellId: number;
  profession: string;
  learn: number | null;
  yellow: number | null;
  green: number | null;
  grey: number | null;
  greenDerived: boolean;
  /** null means an effect without an output item, such as an enchantment. */
  outputItemId: number | null;
  outputCount: number;
  /** Item that teaches the recipe, not an NPC. */
  taughtByItemId: number | null;
  status: 'new' | 'changed' | null;
  reagents: Reagent[];
  limitations: string[];
}

export interface TrainerRecord {
  npcId: number;
  name: string;
  faction: 'alliance' | 'horde' | 'unknown';
  uiMapId: number | null;
  /** Coordinates as 0..1 fractions of uiMapId; null for invalid coordinates. */
  x: number | null;
  y: number | null;
  continentId: number | null;
  continentX: number | null;
  continentY: number | null;
  classToken: string | null;
  profession: string | null;
  limitations: string[];
}

export interface DatasetRecord {
  type: DatasetType;
  recordKey: string;
  sourcePath: string;
  fields: LiteralValue;
  limitations: string[];
}

export type FileStatus =
  | { status: 'decoded'; records: number; skipped: number }
  | { status: 'skipped_file'; reason: string }
  | { status: 'missing' };

export interface SkipEntry {
  type: DatasetType;
  path: string;
  reason: string;
}

export interface DecodedDataset {
  decoderVersion: number;
  datasetId: string;
  archiveSha256: string;
  addonVersion: string | null;
  pack: { version: string | null; build: string | null; hash: string | null; site: string | null };
  files: Record<string, FileStatus>;
  skippedCount: number;
  /** First skipped records and reasons, for get_source_status. */
  skips: SkipEntry[];
  recipes: Record<string, RecipeRecord>;
  trainers: TrainerRecord[];
  names: Record<string, string>;
  /** All records by type and key, including normalized recipes/trainers/search. */
  records: Partial<Record<DatasetType, Record<string, DatasetRecord>>>;
}

export class DecodeError extends Error {
  constructor(
    readonly code: 'required_file_missing' | 'required_file_invalid' | 'too_many_skipped',
    message: string,
  ) {
    super(message);
    this.name = 'DecodeError';
  }
}
