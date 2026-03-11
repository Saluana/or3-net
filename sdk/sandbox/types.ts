export interface SandboxInfo {
  readonly id: string;
  readonly status: string;
  readonly workspace_id?: string;
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
}

export interface SandboxWriteFileRequest {
  readonly path: string;
  readonly content: string;
}

export interface SandboxTunnel {
  readonly id: string;
  readonly sandbox_id: string;
  readonly target_port: number;
  readonly url: string;
  readonly state: string;
}

export interface CreateSandboxRequest {
  readonly workspace_id: string;
  readonly template?: string;
}

export interface CreateTunnelRequest {
  readonly target_port: number;
  readonly label?: string;
}

export interface SandboxClient {
  create(request: CreateSandboxRequest): Promise<SandboxInfo>;
  get(sandboxId: string): Promise<SandboxInfo>;
  delete(sandboxId: string): Promise<void>;
  exec(sandboxId: string, request: SandboxExecRequest): Promise<SandboxExecResult>;
  execStream(sandboxId: string, request: SandboxExecRequest): AsyncIterable<SandboxExecEvent>;
  writeFile(sandboxId: string, request: SandboxWriteFileRequest): Promise<void>;
  createTunnel(sandboxId: string, request: CreateTunnelRequest): Promise<SandboxTunnel>;
  listTunnels(sandboxId: string): Promise<SandboxTunnel[]>;
}