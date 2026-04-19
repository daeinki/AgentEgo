export function formatUsage(usage?: {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    parts.push(`tokens ${usage.inputTokens ?? 0}→${usage.outputTokens ?? 0}`);
  }
  if (usage.costUsd !== undefined) {
    parts.push(`$${usage.costUsd.toFixed(4)}`);
  }
  return parts.join(' · ');
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
