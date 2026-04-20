/**
 * UI copy lives here so future localization only has to touch one file.
 * Keys mirror the sidebar/view structure.
 */
export const strings = {
  app: {
    title: 'Agent Platform',
    subtitle: 'Gateway Dashboard',
  },
  sidebar: {
    chat: 'Chat',
    control: 'Control',
    overview: 'Overview',
    channels: 'Channels',
    instances: 'Instances',
    sessions: 'Sessions',
    cron: 'Cron Jobs',
    agent: 'Agent',
    agents: 'Agents',
    skills: 'Skills',
    nodes: 'Nodes',
    settings: 'Settings',
    config: 'Config',
    debug: 'Debug',
    logs: 'Logs',
    resources: 'Resources',
    docs: 'Docs',
  },
  status: {
    healthOk: 'Health OK',
    healthDown: 'Gateway down',
    connecting: 'Connecting…',
  },
  chat: {
    title: 'Chat',
    description: 'Direct gateway chat session for quick interventions.',
    placeholder:
      'Message (↵ to send, Shift+↵ for line breaks, paste images)',
    newSession: 'New session',
    send: 'Send',
  },
  comingSoon: 'Coming soon',
} as const;

export type Strings = typeof strings;
