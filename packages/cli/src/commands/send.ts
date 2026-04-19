import { generateId, generateTraceId, nowMs } from '@agent-platform/core';
import type { StandardMessage } from '@agent-platform/core';
import { SessionStore, Router } from '@agent-platform/control-plane';
import { AgentRunner } from '@agent-platform/agent-worker';
import { loadEgoConfig, EgoLayer, isEgoEnabled } from '@agent-platform/ego';
import { resolveEnvVars } from '@agent-platform/core';
import { createModelAdapter } from '../runtime/model-adapter.js';
import { resolveDefaultSessionDb } from '../runtime/session-db.js';

interface SendOptions {
  session?: string;
  agent: string;
  db?: string;
}

export async function sendCommand(messageText: string, options: SendOptions): Promise<void> {
  const dbPath = options.db ?? (await resolveDefaultSessionDb());
  const sessionStore = new SessionStore(dbPath);

  try {
    // Build StandardMessage
    const msg: StandardMessage = {
      id: generateId(),
      traceId: generateTraceId(),
      timestamp: nowMs(),
      channel: {
        type: 'webchat',
        id: 'cli',
        metadata: {},
      },
      sender: {
        id: 'cli-user',
        isOwner: true,
      },
      conversation: {
        type: 'dm',
        id: options.session ?? 'cli-default',
      },
      content: {
        type: 'text',
        text: messageText,
      },
    };

    // EGO layer (optional)
    const egoConfig = await loadEgoConfig();
    // Route first so we have sessionId available for EGO
    const router = new Router(sessionStore, options.agent);
    const route = router.route(msg);

    let effectiveMsg: StandardMessage = msg;
    if (egoConfig && isEgoEnabled(egoConfig)) {
      const ego = new EgoLayer(egoConfig);
      const decision = await ego.process(msg, {
        sessionId: route.sessionId,
        agentId: route.agentId,
      });

      if (decision.action === 'direct_response') {
        if (decision.content.type === 'text') {
          console.log(`\n[EGO direct] ${decision.content.text}\n`);
        }
        return;
      }
      if (decision.action === 'enrich') {
        effectiveMsg = decision.enrichedMessage;
      }
      // redirect is handled inside EgoLayer via SessionManager when provided.
    }

    // Create LLM adapter (provider picked from AGENT_PROVIDER or model-name heuristic)
    const model = createModelAdapter();

    // Run agent
    const runner = new AgentRunner(sessionStore, model, {
      agentId: route.agentId,
    });

    process.stdout.write('\n');
    const result = await runner.processTurn(route.sessionId, effectiveMsg, (text) => {
      process.stdout.write(text);
    });
    process.stdout.write('\n\n');

    // Print stats
    console.log(
      `[tokens: ${result.inputTokens}→${result.outputTokens}` +
        (result.costUsd ? ` | cost: $${result.costUsd.toFixed(4)}` : '') +
        ` | ${result.latencyMs.toFixed(0)}ms]`,
    );
  } finally {
    sessionStore.close();
  }
}

