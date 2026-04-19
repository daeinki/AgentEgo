import React from 'react';
import { render } from 'ink';
import { App, type AppProps } from './App.js';

export { App } from './App.js';
export type { AppProps } from './App.js';
export { RpcClient } from './lib/rpc-client.js';
export type { RpcClientOptions, CallOptions } from './lib/rpc-client.js';

/**
 * Imperative entry point called by the CLI command. Renders the TUI and
 * returns a handle the caller can await to block until the user quits.
 */
export function runTui(props: AppProps): Promise<void> {
  const instance = render(<App {...props} />);
  return instance.waitUntilExit();
}
