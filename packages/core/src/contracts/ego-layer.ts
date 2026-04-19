import type { StandardMessage } from '../types/message.js';
import type { EgoDecision } from '../types/ego.js';
import type { EgoContext } from '../schema/ego-context.js';

export interface EgoLayer {
  process(msg: StandardMessage, ctx: EgoContext): Promise<EgoDecision>;
}
