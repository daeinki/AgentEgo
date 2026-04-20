import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { GatewayController } from './gateway-controller.js';

export interface OverviewStatus {
  ok: boolean;
  version: string;
  uptimeMs: number;
  sessionCount: number;
  sessionsByStatus: Record<string, number>;
  activeAgents: string[];
  channelCount: number;
  memMB: number;
  pid: number;
}

export interface ChannelDescriptor {
  id: string;
  type: string;
  status: 'connected' | 'disconnected' | 'error' | 'unknown';
  lastEventAt?: number;
  error?: string;
  sessionCount?: number;
}

export interface InstanceDescriptor {
  agentId: string;
  sessionCount: number;
  active: number;
  hibernated: number;
}

export interface CronTaskDescriptor {
  id: string;
  spec: string;
  status: 'idle' | 'running' | 'disabled' | 'error';
  nextRunAt?: number;
  lastRunAt?: number;
  lastError?: string;
}

export interface SessionSummary {
  id: string;
  agentId: string;
  channelType: string;
  conversationId: string;
  status: string;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Periodic poller for the Control-section views. Pauses when the tab is
 * hidden to avoid burning battery. Each view reads its slice of the
 * snapshot; views never call RPC directly for list data.
 */
export class PollingController implements ReactiveController {
  private readonly host: ReactiveControllerHost;
  private readonly gateway: GatewayController;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;

  overview: OverviewStatus | null = null;
  channels: ChannelDescriptor[] = [];
  instances: InstanceDescriptor[] = [];
  cron: CronTaskDescriptor[] = [];
  sessions: SessionSummary[] = [];
  lastError: string | null = null;

  constructor(
    host: ReactiveControllerHost,
    gateway: GatewayController,
    intervalMs = 5000,
  ) {
    this.host = host;
    this.gateway = gateway;
    this.intervalMs = intervalMs;
    host.addController(this);
  }

  hostConnected(): void {
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') this.kick();
      else this.stop();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.kick();
  }

  hostDisconnected(): void {
    this.stop();
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  /** Force one poll now (used after user actions e.g. "new session"). */
  kick(): void {
    this.stop();
    void this.tick();
  }

  private stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.gateway.status !== 'open') {
      this.timer = setTimeout(() => this.tick(), this.intervalMs);
      return;
    }
    try {
      const [overview, channels, instances, cron, sessions] = await Promise.all([
        this.gateway.call<OverviewStatus>('overview.status'),
        this.gateway
          .call<{ channels: ChannelDescriptor[] }>('channels.list')
          .then((r) => r.channels),
        this.gateway
          .call<{ instances: InstanceDescriptor[] }>('instances.list')
          .then((r) => r.instances),
        this.gateway
          .call<{ tasks: CronTaskDescriptor[] }>('cron.list')
          .then((r) => r.tasks),
        this.gateway
          .call<{ sessions: SessionSummary[] }>('sessions.list')
          .then((r) => r.sessions),
      ]);
      this.overview = overview;
      this.channels = channels;
      this.instances = instances;
      this.cron = cron;
      this.sessions = sessions;
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message;
    }
    this.host.requestUpdate();
    if (document.visibilityState === 'visible') {
      this.timer = setTimeout(() => this.tick(), this.intervalMs);
    }
  }
}
