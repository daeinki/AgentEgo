import type { Persona, PersonaSnapshot, PersonaFeedback } from '../schema/persona.js';

export interface EvolutionResult {
  changed: boolean;
  fieldPath?: string;
  delta?: number;
  reason?: string;
}

export interface PersonaExport {
  format: 'ego-persona-v1';
  exportedAt: string;
  sourceAgentId: string;
  sourceInstanceId: string;
  persona: Persona;
  includeMemory?: boolean;
  checksum: string;
}

export interface NormalizedSignalLike {
  rawText: string;
  entities?: { type: string; value: string }[];
}

export interface PersonaManager {
  load(): Promise<Persona>;
  snapshot(signal: NormalizedSignalLike): Promise<PersonaSnapshot>;
  evolve(feedback: PersonaFeedback): Promise<EvolutionResult>;
  export(): Promise<PersonaExport>;
  import(data: PersonaExport): Promise<void>;
}
