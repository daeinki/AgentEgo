export { generateId, generateTraceId } from '../ids.js';
export { nowMs } from '../time.js';

export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const envValue = process.env[name];
    if (!envValue) {
      throw new Error(`Environment variable ${name} is not set`);
    }
    return envValue;
  });
}
