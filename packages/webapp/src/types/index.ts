/**
 * Shared frontend-only types. Schema-level types (Phase, SessionEvent, etc.)
 * should be imported from `@agent-platform/core` instead of redeclared here.
 */

export type ThemePreference = 'light' | 'dark' | 'system';

export type ViewId =
  | 'chat'
  | 'overview'
  | 'channels'
  | 'instances'
  | 'sessions'
  | 'cron';

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  streaming?: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
}
