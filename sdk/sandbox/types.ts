export interface SandboxInfo {
  readonly id: string;
  readonly status: string;
  readonly workspace_id?: string;
  readonly runtime_backend?: string;
  readonly network_mode?: string;
}

export interface SandboxFileContent {
  readonly path: string;
  readonly content?: string;
  readonly content_base64?: string;
  readonly encoding?: string;
}

export interface SandboxExecRequest {
  readonly command: string[];
  readonly cwd?: string;
}

export interface SandboxExecEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

export interface SandboxExecResult {
  readonly exit_code: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: string;
}

export interface SandboxWriteFileRequest {
  readonly path: string;
  readonly content: string;
}

export interface SandboxTunnel {
  readonly id: string;
  readonly sandbox_id: string;
  readonly target_port: number;
  readonly endpoint: string;
  readonly access_token?: string;
  readonly auth_mode?: string;
  readonly visibility?: string;
}

export interface CreateSandboxRequest {
  readonly workspace_id?: string;
  readonly base_image_ref?: string;
  readonly start?: boolean;
  readonly allow_tunnels?: boolean;
  readonly network_mode?: string;
}

export interface CreateTunnelRequest {
  readonly target_port: number;
  readonly protocol?: string;
  readonly auth_mode?: string;
  readonly visibility?: string;
}

export interface CreateTunnelSignedUrlRequest {
  readonly path?: string;
  readonly ttl_seconds?: number;
}

export interface SandboxTunnelSignedUrl {
  readonly url: string;
  readonly expires_at: string;
}

export interface RuntimeHealth {
  readonly status: string;
  readonly [key: string]: unknown;
}

export interface RuntimeInfo {
  readonly [key: string]: unknown;
}

export interface RuntimeCapacity {
  readonly [key: string]: unknown;
}

export interface SandboxQuota {
  readonly [key: string]: unknown;
}

export interface SandboxClient {
  create(request: CreateSandboxRequest): Promise<SandboxInfo>;
  list(): Promise<SandboxInfo[]>;
  get(sandboxId: string): Promise<SandboxInfo>;
  delete(sandboxId: string): Promise<void>;
  start(sandboxId: string): Promise<SandboxInfo>;
  stop(sandboxId: string): Promise<SandboxInfo>;
  suspend(sandboxId: string): Promise<SandboxInfo>;
  resume(sandboxId: string): Promise<SandboxInfo>;
  exec(sandboxId: string, request: SandboxExecRequest): Promise<SandboxExecResult>;
  execStream(sandboxId: string, request: SandboxExecRequest): AsyncIterable<SandboxExecEvent>;
  readFile(sandboxId: string, path: string): Promise<SandboxFileContent>;
  writeFile(sandboxId: string, request: SandboxWriteFileRequest): Promise<void>;
  deleteFile(sandboxId: string, path: string): Promise<void>;
  mkdir(sandboxId: string, path: string): Promise<void>;
  createTunnel(sandboxId: string, request: CreateTunnelRequest): Promise<SandboxTunnel>;
  listTunnels(sandboxId: string): Promise<SandboxTunnel[]>;
  revokeTunnel(tunnelId: string): Promise<void>;
  createSignedTunnelUrl(tunnelId: string, request?: CreateTunnelSignedUrlRequest): Promise<SandboxTunnelSignedUrl>;
  runtimeInfo(): Promise<RuntimeInfo>;
  runtimeHealth(): Promise<RuntimeHealth>;
  runtimeCapacity(): Promise<RuntimeCapacity>;
  getQuota(): Promise<SandboxQuota>;
  getMetrics(): Promise<string>;
}
