import { $ } from "bun";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type OpenSandboxEnv = Record<string, string>;

const rootDir = resolve(import.meta.dir, "..");
const envPath = resolve(rootDir, ".local/opensandbox/env.sh");

const logStep = (message: string): void => {
  process.stdout.write(`\n==> ${message}\n`);
};

const runShellStep = async (message: string, command: string, env?: NodeJS.ProcessEnv): Promise<void> => {
  logStep(message);
  await $`bash -lc ${command}`.cwd(rootDir).env(env);
};

const parseEnvFile = async (filePath: string): Promise<OpenSandboxEnv> => {
  const fileContents = await readFile(filePath, "utf8");
  const entries = fileContents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("export "))
    .map((line) => line.slice("export ".length))
    .map((line) => {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        return null;
      }

      const key = line.slice(0, separatorIndex).trim();
      const rawValue = line.slice(separatorIndex + 1).trim();
      const value = rawValue.replace(/^"|"$/gu, "");
      return [key, value] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);

  return Object.fromEntries(entries) as OpenSandboxEnv;
};

const buildBaseUrl = (env: OpenSandboxEnv): string => {
  const protocol = env["OR3_NET_OPENSANDBOX_PROTOCOL"] ?? "http";
  const domain = env["OR3_NET_OPENSANDBOX_DOMAIN"] ?? "127.0.0.1:8080";
  return `${protocol}://${domain}`;
};

const isServerHealthy = async (baseUrl: string): Promise<boolean> => {
  try {
    const response = await fetch(`${baseUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

const waitForServer = async (baseUrl: string, timeoutMs: number): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isServerHealthy(baseUrl)) {
      return;
    }
    await Bun.sleep(1000);
  }

  throw new Error(`OpenSandbox server is not reachable at ${baseUrl}/health`);
};

const main = async (): Promise<void> => {
  await runShellStep("bootstrapping local OpenSandbox toolchain", "bash ./scripts/opensandbox/opensandbox-init.sh");

  if (!existsSync(envPath)) {
    throw new Error(`OpenSandbox env file was not created at ${envPath}`);
  }

  const openSandboxEnv = await parseEnvFile(envPath);
  const baseUrl = buildBaseUrl(openSandboxEnv);

  let serverProcess: Bun.Subprocess | null = null;
  if (await isServerHealthy(baseUrl)) {
    logStep(`OpenSandbox server already healthy at ${baseUrl}`);
  } else {
    logStep(`starting OpenSandbox server and streaming logs from ${baseUrl}`);
    serverProcess = Bun.spawn(["bash", "./scripts/opensandbox/opensandbox-server.sh"], {
      cwd: rootDir,
      env: process.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });

    try {
      await waitForServer(baseUrl, 60_000);
    } catch (error) {
      serverProcess.kill();
      await serverProcess.exited;
      throw error;
    }
  }

  const stopServer = async (): Promise<void> => {
    if (serverProcess === null || serverProcess.killed) {
      return;
    }
    logStep("stopping OpenSandbox server started by this runner");
    serverProcess.kill();
    await serverProcess.exited;
  };

  const handleSignal = async (signal: string): Promise<void> => {
    logStep(`received ${signal}; cleaning up`);
    await stopServer();
    process.exit(1);
  };

  process.on("SIGINT", () => {
    void handleSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    void handleSignal("SIGTERM");
  });

  try {
    await runShellStep(
      "running OR3 OpenSandbox smoke test",
      "source ./.local/opensandbox/env.sh && bun ./scripts/opensandbox/opensandbox-manual-test.ts",
    );
    await runShellStep(
      "running upstream OpenSandbox CLI smoke test",
      "source ./.local/opensandbox/env.sh && bash ./scripts/opensandbox/opensandbox-cli-smoke.sh",
    );
    logStep("OpenSandbox streaming run finished successfully");
  } finally {
    await stopServer();
  }
};

await main();