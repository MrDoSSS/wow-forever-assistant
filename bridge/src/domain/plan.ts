// Active plan for the prompt: the addon sends its source reply key and step marks;
// the bridge reads the plan from the saved reply instead of retransmitting it.
import { GameReply, type ActivePlanRef } from '../contracts.js';
import type { Store } from '../storage/store.js';

export interface ActivePlanStep {
  n: number;
  kind: string;
  text: string;
  character: string | null;
  itemId: number | null;
  quantity: number | null;
  mailTo: string | null;
  mailFrom: string | null;
  moneyCopper: number | null;
  skillRank: number | null;
  done: boolean;
}

/** null means no active plan; unavailable means its source reply was deleted with the conversation. */
export type ActivePlanBrief = { title: string; steps: ActivePlanStep[] } | { unavailable: true } | null;

export function activePlanBrief(store: Store, ref: ActivePlanRef | null | undefined): ActivePlanBrief {
  if (!ref) return null;
  const row = store.getReplyForRequest(ref.request);
  const parsed = row ? GameReply.safeParse(JSON.parse(row.body_json)) : null;
  const plan = parsed?.success ? parsed.data.plan : null;
  if (!plan) return { unavailable: true };
  return {
    title: plan.title,
    steps: plan.steps.map((step, index) => ({
      n: index + 1,
      kind: step.kind,
      text: step.text,
      character: step.character,
      itemId: step.item?.itemId ?? null,
      quantity: step.quantity,
      mailTo: step.mailTo,
      mailFrom: step.mailFrom,
      moneyCopper: step.moneyCopper,
      skillRank: step.skillRank,
      done: ref.done[index] === true,
    })),
  };
}
