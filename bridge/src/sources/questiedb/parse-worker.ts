import { decodeQuestieDataset } from './decode.js';
import { QuestieDataError } from './cbor.js';

process.once('message', (message: { files: [string, Uint8Array][]; metadata: Parameters<typeof decodeQuestieDataset>[1] }) => {
  try {
    const dataset = decodeQuestieDataset(new Map(message.files), message.metadata);
    process.send?.({ ok: true, dataset });
  } catch (error) {
    process.send?.({ ok: false, code: error instanceof QuestieDataError ? error.code : 'unsupported_format', message: String(error) });
  }
});
