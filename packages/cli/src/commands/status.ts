import { SessionStore } from '@agent-platform/control-plane';
import { loadEgoConfig, isEgoEnabled } from '@agent-platform/ego';
import { resolveDefaultSessionDb } from '../runtime/session-db.js';

interface StatusOptions {
  db?: string;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  console.log('=== Agent Platform Status ===\n');

  const dbPath = options.db ?? (await resolveDefaultSessionDb());

  // Session store
  try {
    const store = new SessionStore(dbPath);
    console.log(`Session DB: ${dbPath}`);
    store.close();
    console.log('Session store: OK');
  } catch (err) {
    console.log(`Session store: ERROR - ${(err as Error).message}`);
  }

  // EGO config
  const egoConfig = await loadEgoConfig();
  if (egoConfig) {
    console.log(`\nEGO state: ${egoConfig.state}`);
    console.log(`EGO operational: ${isEgoEnabled(egoConfig) ? 'yes' : 'no'}`);
    if (egoConfig.llm) {
      console.log(`EGO LLM: ${egoConfig.llm.provider}/${egoConfig.llm.model}`);
    }
  } else {
    console.log('\nEGO: not configured (ego.json not found)');
  }

  // LLM key check
  console.log(`\nANTHROPIC_API_KEY: ${process.env['ANTHROPIC_API_KEY'] ? 'set' : 'not set'}`);
  console.log(`OPENAI_API_KEY: ${process.env['OPENAI_API_KEY'] ? 'set' : 'not set'}`);
}
