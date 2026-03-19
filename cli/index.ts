export const cliName = "or3-net";

interface CliDependencies {
	readonly fetch: typeof fetch;
	readonly stdout: { write(chunk: string): void };
	readonly stderr: { write(chunk: string): void };
}

interface ParsedArgs {
	readonly commandPath: string[];
	readonly flags: Record<string, string>;
	readonly booleanFlags: ReadonlySet<string>;
}

const defaultBaseUrl = "http://127.0.0.1:3001";

export const runCli = async (argv: string[], deps: CliDependencies): Promise<number> => {
	const parsed = parseArgs(argv);
	const [section, action] = parsed.commandPath;

	if (section === undefined || section === "help" || parsed.booleanFlags.has("help")) {
		deps.stdout.write(renderHelp());
		return 0;
	}

	try {
		switch (`${section}:${action ?? ""}`) {
			case "auth:exchange":
				await handleAuthExchange(parsed.flags, deps);
				return 0;
				case "runtimes:list":
					await handleJsonRequest("GET", buildWorkspacePath(parsed.flags, "/runtimes"), parsed.flags, deps);
					return 0;
				case "runtimes:get":
					await handleJsonRequest(
						"GET",
						buildWorkspacePath(parsed.flags, `/runtimes/${requireFlag(parsed.flags, "runtime-id")}`),
						parsed.flags,
						deps,
					);
					return 0;
				case "runtimes:nodes":
					await handleJsonRequest(
						"GET",
						buildWorkspacePath(parsed.flags, `/runtimes/${requireFlag(parsed.flags, "runtime-id")}/nodes`),
						parsed.flags,
						deps,
					);
					return 0;
				case "runtime-sessions:list": {
					const search = new URLSearchParams();
					if (parsed.flags["status"] !== undefined) {
						search.set("status", parsed.flags["status"]);
					}
					if (parsed.flags["adapter-id"] !== undefined) {
						search.set("adapter_id", parsed.flags["adapter-id"]);
					}
					if (parsed.flags["limit"] !== undefined) {
						search.set("limit", parsed.flags["limit"]);
					}
					const path = `${buildWorkspacePath(parsed.flags, "/runtime-sessions")}${search.size === 0 ? "" : `?${search.toString()}`}`;
					await handleJsonRequest("GET", path, parsed.flags, deps);
					return 0;
				}
				case "runtime-sessions:create":
					await handleCreateRuntimeSession(parsed.flags, deps);
					return 0;
				case "runtime-sessions:get":
					await handleJsonRequest(
						"GET",
						buildWorkspacePath(parsed.flags, `/runtime-sessions/${requireFlag(parsed.flags, "session-id")}`),
						parsed.flags,
						deps,
					);
					return 0;
				case "runtime-sessions:exec":
					await handleJsonRequest(
						"POST",
						buildWorkspacePath(parsed.flags, `/runtime-sessions/${requireFlag(parsed.flags, "session-id")}/exec`),
						parsed.flags,
						deps,
						{
							command: requireFlag(parsed.flags, "command"),
							args: parsed.flags["args-json"] === undefined ? [] : parseStringArrayFlag(parsed.flags, "args-json"),
							...(parsed.flags["cwd"] === undefined ? {} : { cwd: parsed.flags["cwd"] }),
							env: parsed.flags["env-json"] === undefined ? {} : parseStringRecordFlag(parsed.flags, "env-json"),
							...(parsed.flags["timeout-ms"] === undefined ? {} : { timeout_ms: Number(requireFlag(parsed.flags, "timeout-ms")) }),
							...(parsed.flags["stdin"] === undefined ? {} : { stdin: parsed.flags["stdin"] }),
							background: parsed.booleanFlags.has("background"),
						},
					);
					return 0;
				case "runtime-sessions:logs": {
					const search = new URLSearchParams();
					if (parsed.flags["cursor"] !== undefined) {
						search.set("cursor", parsed.flags["cursor"]);
					}
					if (parsed.flags["limit"] !== undefined) {
						search.set("limit", parsed.flags["limit"]);
					}
					const path = `${buildWorkspacePath(parsed.flags, `/runtime-sessions/${requireFlag(parsed.flags, "session-id")}/logs`)}${search.size === 0 ? "" : `?${search.toString()}`}`;
					await handleJsonRequest("GET", path, parsed.flags, deps);
					return 0;
				}
				case "runtime-sessions:copy-in":
					await handleJsonRequest(
						"POST",
						buildWorkspacePath(parsed.flags, `/runtime-sessions/${requireFlag(parsed.flags, "session-id")}/files:copy-in`),
						parsed.flags,
						deps,
						{
							destination_path: requireFlag(parsed.flags, "destination-path"),
							...(parsed.flags["content-text"] === undefined ? {} : { content_text: parsed.flags["content-text"] }),
							...(parsed.flags["content-base64"] === undefined ? {} : { content_base64: parsed.flags["content-base64"] }),
							...(parsed.flags["source-path"] === undefined ? {} : { source_path: parsed.flags["source-path"] }),
							overwrite: parsed.booleanFlags.has("no-overwrite") ? false : true,
						},
					);
					return 0;
				case "runtime-sessions:copy-out":
					await handleJsonRequest(
						"POST",
						buildWorkspacePath(parsed.flags, `/runtime-sessions/${requireFlag(parsed.flags, "session-id")}/files:copy-out`),
						parsed.flags,
						deps,
						{
							source_path: requireFlag(parsed.flags, "source-path"),
							...(parsed.flags["destination-path"] === undefined ? {} : { destination_path: parsed.flags["destination-path"] }),
							...(parsed.flags["encoding"] === undefined ? {} : { encoding: parsed.flags["encoding"] }),
						},
					);
					return 0;
				case "runtime-sessions:stop":
					await handleJsonRequest(
						"POST",
						buildWorkspacePath(parsed.flags, `/runtime-sessions/${requireFlag(parsed.flags, "session-id")}/stop`),
						parsed.flags,
						deps,
					);
					return 0;
				case "runtime-sessions:destroy":
					await handleJsonRequest(
						"POST",
						buildWorkspacePath(parsed.flags, `/runtime-sessions/${requireFlag(parsed.flags, "session-id")}/destroy`),
						parsed.flags,
						deps,
					);
					return 0;
				case "runtime-sessions:commit":
					await handleJsonRequest(
						"POST",
						buildWorkspacePath(parsed.flags, `/runtime-sessions/${requireFlag(parsed.flags, "session-id")}/commit`),
						parsed.flags,
						deps,
					);
					return 0;
				case "runtime-sessions:discard":
					await handleJsonRequest(
						"POST",
						buildWorkspacePath(parsed.flags, `/runtime-sessions/${requireFlag(parsed.flags, "session-id")}/discard`),
						parsed.flags,
						deps,
					);
					return 0;
				case "runtime-sessions:staging":
					await handleJsonRequest(
						"GET",
						buildWorkspacePath(parsed.flags, `/runtime-sessions/${requireFlag(parsed.flags, "session-id")}/staging`),
						parsed.flags,
						deps,
					);
					return 0;
			case "api-keys:list":
				await handleJsonRequest("GET", buildWorkspacePath(parsed.flags, "/api-keys"), parsed.flags, deps);
				return 0;
			case "api-keys:create":
				await handleJsonRequest(
					"POST",
					buildWorkspacePath(parsed.flags, "/api-keys"),
					parsed.flags,
					deps,
					{
						name: requireFlag(parsed.flags, "name"),
						scopes: splitCsv(requireFlag(parsed.flags, "scopes")),
						...(parsed.flags["expires-at"] === undefined ? {} : { expires_at: parsed.flags["expires-at"] }),
					},
				);
				return 0;
			case "api-keys:revoke":
				await handleJsonRequest(
					"POST",
					buildWorkspacePath(parsed.flags, `/api-keys/${requireFlag(parsed.flags, "api-key-id")}/revoke`),
					parsed.flags,
					deps,
				);
				return 0;
			case "nodes:list":
				await handleJsonRequest("GET", buildWorkspacePath(parsed.flags, "/nodes"), parsed.flags, deps);
				return 0;
			case "nodes:approve":
				await handleJsonRequest("POST", buildWorkspacePath(parsed.flags, `/nodes/${requireFlag(parsed.flags, "node-id")}/approve`), parsed.flags, deps);
				return 0;
			case "services:list":
				await handleJsonRequest(
					"GET",
					buildWorkspacePath(parsed.flags, `/nodes/${requireFlag(parsed.flags, "node-id")}/services`),
					parsed.flags,
					deps,
				);
				return 0;
			case "services:revoke":
				await handleJsonRequest(
					"POST",
					buildWorkspacePath(parsed.flags, `/nodes/${requireFlag(parsed.flags, "node-id")}/services/${requireFlag(parsed.flags, "service-id")}/revoke`),
					parsed.flags,
					deps,
				);
				return 0;
			case "services:restart":
				await handleJsonRequest(
					"POST",
					buildWorkspacePath(parsed.flags, `/nodes/${requireFlag(parsed.flags, "node-id")}/services/${requireFlag(parsed.flags, "service-id")}/restart`),
					parsed.flags,
					deps,
				);
				return 0;
			case "nodes:enroll":
				await handleJsonRequest(
					"POST",
					buildWorkspacePath(parsed.flags, "/nodes/enroll"),
					parsed.flags,
					deps,
					parseJsonFlag(parsed.flags, "manifest-json"),
				);
				return 0;
			case "jobs:submit":
				await handleJsonRequest(
					"POST",
					buildWorkspacePath(parsed.flags, "/jobs"),
					parsed.flags,
					deps,
					{
						session_key: requireFlag(parsed.flags, "session-key"),
						message: requireFlag(parsed.flags, "message"),
						allowed_tools: splitCsv(parsed.flags["allowed-tools"]),
					},
				);
				return 0;
			case "jobs:list": {
				const search = new URLSearchParams();
				if (parsed.flags["status"] !== undefined) {
					search.set("status", parsed.flags["status"]);
				}
				if (parsed.flags["session-id"] !== undefined) {
					search.set("network_session_id", parsed.flags["session-id"]);
				}
				const path = `${buildWorkspacePath(parsed.flags, "/jobs")}${search.size === 0 ? "" : `?${search.toString()}`}`;
				await handleJsonRequest("GET", path, parsed.flags, deps);
				return 0;
			}
			case "jobs:get":
				await handleJsonRequest("GET", `/v1/jobs/${requireFlag(parsed.flags, "job-id")}`, parsed.flags, deps);
				return 0;
			case "jobs:abort":
				await handleJsonRequest("POST", `/v1/jobs/${requireFlag(parsed.flags, "job-id")}/abort`, parsed.flags, deps);
				return 0;
			case "jobs:stream":
				await handleStreamRequest(`/v1/jobs/${requireFlag(parsed.flags, "job-id")}/stream`, parsed.flags, deps);
				return 0;
			case "sessions:list":
				await handleJsonRequest("GET", buildWorkspacePath(parsed.flags, "/sessions"), parsed.flags, deps);
				return 0;
			case "sessions:get":
				await handleJsonRequest(
					"GET",
					buildWorkspacePath(parsed.flags, `/sessions/${requireFlag(parsed.flags, "session-id")}`),
					parsed.flags,
					deps,
				);
				return 0;
			case "sessions:events":
				await handleJsonRequest(
					"GET",
					buildWorkspacePath(parsed.flags, `/sessions/${requireFlag(parsed.flags, "session-id")}/events`),
					parsed.flags,
					deps,
				);
				return 0;
			case "previews:list":
				await handleJsonRequest("GET", buildWorkspacePath(parsed.flags, "/previews"), parsed.flags, deps);
				return 0;
			case "previews:revoke":
				await handleJsonRequest(
					"POST",
					buildWorkspacePath(parsed.flags, `/previews/${requireFlag(parsed.flags, "preview-id")}/revoke`),
					parsed.flags,
					deps,
				);
				return 0;
			case "agents:list":
				await handleJsonRequest("GET", buildWorkspacePath(parsed.flags, "/agents"), parsed.flags, deps);
				return 0;
			default:
				deps.stderr.write(`Unknown command: ${parsed.commandPath.join(" ")}\n\n${renderHelp()}`);
				return 1;
		}
	} catch (error) {
		deps.stderr.write(`${error instanceof Error ? error.message : "CLI command failed"}\n`);
		return 1;
	}
};

const parseArgs = (argv: string[]): ParsedArgs => {
	const commandPath: string[] = [];
	const flags: Record<string, string> = {};
	const booleanFlags = new Set<string>();

	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === undefined) {
			continue;
		}
		if (value.startsWith("--")) {
			const key = value.slice(2);
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) {
				booleanFlags.add(key);
				continue;
			}
			flags[key] = next;
			index += 1;
			continue;
		}

		commandPath.push(value);
	}

	return { commandPath, flags, booleanFlags };
};

const buildWorkspacePath = (flags: Record<string, string>, suffix: string): string =>
	`/v1/workspaces/${requireFlag(flags, "workspace-id")}${suffix}`;

const requireFlag = (flags: Record<string, string>, key: string): string => {
	const value = flags[key];
	if (value === undefined || value.trim() === "") {
		throw new Error(`Missing required flag --${key}`);
	}
	return value;
};

const parseJsonFlag = (flags: Record<string, string>, key: string): unknown => JSON.parse(requireFlag(flags, key)) as unknown;

const parseObjectFlag = (flags: Record<string, string>, key: string): Record<string, unknown> => {
	const value = parseJsonFlag(flags, key);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Flag --${key} must be a JSON object`);
	}
	return value as Record<string, unknown>;
};

const parseStringArrayFlag = (flags: Record<string, string>, key: string): string[] => {
	const value = parseJsonFlag(flags, key);
	if (!Array.isArray(value)) {
		throw new Error(`Flag --${key} must be a JSON string array`);
	}

	const items: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			throw new Error(`Flag --${key} must be a JSON string array`);
		}
		items.push(entry);
	}
	return items;
};

const parseStringRecordFlag = (flags: Record<string, string>, key: string): Record<string, string> => {
	const value = parseObjectFlag(flags, key);
	return Object.fromEntries(
		Object.entries(value).map(([entryKey, entryValue]) => {
			if (typeof entryValue !== "string") {
				throw new Error(`Flag --${key} must contain only string values`);
			}
			return [entryKey, entryValue];
		}),
	);
};

const handleCreateRuntimeSession = async (flags: Record<string, string>, deps: CliDependencies): Promise<void> => {
	const input = flags["input-json"] === undefined ? {} : parseObjectFlag(flags, "input-json");
	await handleJsonRequest(
		"POST",
		buildWorkspacePath(flags, "/runtime-sessions"),
		flags,
		deps,
		{
			...input,
			...(flags["runtime-id"] === undefined ? {} : { adapter_id: requireFlag(flags, "runtime-id") }),
		},
	);
};

const splitCsv = (value: string | undefined): string[] =>
	value === undefined || value.trim() === "" ? [] : value.split(",").map((item) => item.trim()).filter((item) => item !== "");

const buildUrl = (flags: Record<string, string>, path: string): URL => new URL(path, flags["base-url"] ?? defaultBaseUrl);

const authHeaders = (flags: Record<string, string>, includeJson: boolean): Record<string, string> => ({
	...(flags["token"] === undefined ? {} : { Authorization: `Bearer ${flags["token"]}` }),
	...(includeJson ? { "Content-Type": "application/json" } : {}),
});

const handleAuthExchange = async (flags: Record<string, string>, deps: CliDependencies): Promise<void> => {
	await handleJsonRequest(
		"POST",
		"/v1/auth/exchange",
		flags,
		deps,
		{
			provider: flags["provider"] ?? "test",
			workspace_id: requireFlag(flags, "workspace-id"),
			session_proof: flags["proof-json"] === undefined ? { ok: true } : parseJsonFlag(flags, "proof-json"),
		},
	);
};

const handleJsonRequest = async (
	method: string,
	path: string,
	flags: Record<string, string>,
	deps: CliDependencies,
	body?: unknown,
): Promise<void> => {
	const response = await deps.fetch(buildUrl(flags, path), {
		method,
		headers: authHeaders(flags, body !== undefined),
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(text === "" ? `Request failed with status ${String(response.status)}` : text);
	}
	deps.stdout.write(`${formatJson(text)}\n`);
};

const handleStreamRequest = async (path: string, flags: Record<string, string>, deps: CliDependencies): Promise<void> => {
	const response = await deps.fetch(buildUrl(flags, path), {
		method: "GET",
		headers: authHeaders(flags, false),
	});
	if (!response.ok) {
		throw new Error(`Stream request failed with status ${String(response.status)}`);
	}
	deps.stdout.write(`${await response.text()}\n`);
};

const formatJson = (text: string): string => {
	try {
		return JSON.stringify(JSON.parse(text) as unknown, null, 2);
	} catch {
		return text;
	}
};

const renderHelp = (): string => `${cliName} commands:
	auth exchange --workspace-id <id> [--provider test] [--proof-json '{"ok":true}'] [--base-url <url>]
	runtimes list --workspace-id <id> --token <token> [--base-url <url>]
	runtimes get --workspace-id <id> --runtime-id <id> --token <token> [--base-url <url>]
	runtimes nodes --workspace-id <id> --runtime-id <id> --token <token> [--base-url <url>]
	runtime-sessions list --workspace-id <id> --token <token> [--status <status>] [--adapter-id <id>] [--limit <n>] [--base-url <url>]
	runtime-sessions create --workspace-id <id> --token <token> [--runtime-id <id>] [--input-json '<json>'] [--base-url <url>]
	runtime-sessions get --workspace-id <id> --session-id <id> --token <token> [--base-url <url>]
	runtime-sessions exec --workspace-id <id> --session-id <id> --token <token> --command <cmd> [--args-json '["arg1","arg2"]'] [--cwd <path>] [--env-json '{"KEY":"value"}'] [--timeout-ms <n>] [--stdin <text>] [--background] [--base-url <url>]
	runtime-sessions logs --workspace-id <id> --session-id <id> --token <token> [--cursor <cursor>] [--limit <n>] [--base-url <url>]
	runtime-sessions copy-in --workspace-id <id> --session-id <id> --token <token> --destination-path <path> [--content-text <text> | --content-base64 <b64> | --source-path <path>] [--no-overwrite] [--base-url <url>]
	runtime-sessions copy-out --workspace-id <id> --session-id <id> --token <token> --source-path <path> [--destination-path <path>] [--encoding text|base64] [--base-url <url>]
	runtime-sessions stop --workspace-id <id> --session-id <id> --token <token> [--base-url <url>]
	runtime-sessions destroy --workspace-id <id> --session-id <id> --token <token> [--base-url <url>]
	runtime-sessions commit --workspace-id <id> --session-id <id> --token <token> [--base-url <url>]
	runtime-sessions discard --workspace-id <id> --session-id <id> --token <token> [--base-url <url>]
	runtime-sessions staging --workspace-id <id> --session-id <id> --token <token> [--base-url <url>]
	api-keys list --workspace-id <id> --token <token> [--base-url <url>]
	api-keys create --workspace-id <id> --token <token> --name <name> --scopes jobs:read,jobs:write [--expires-at <iso>] [--base-url <url>]
	api-keys revoke --workspace-id <id> --api-key-id <id> --token <token> [--base-url <url>]
	nodes list --workspace-id <id> --token <token> [--base-url <url>]
	nodes enroll --workspace-id <id> --token <token> --manifest-json '<json>' [--base-url <url>]
	nodes approve --workspace-id <id> --node-id <id> --token <token> [--base-url <url>]
	services list --workspace-id <id> --node-id <id> --token <token> [--base-url <url>]
	services revoke --workspace-id <id> --node-id <id> --service-id <id> --token <token> [--base-url <url>]
	services restart --workspace-id <id> --node-id <id> --service-id <id> --token <token> [--base-url <url>]
	jobs submit --workspace-id <id> --session-key <key> --message <text> --token <token> [--allowed-tools a,b]
	jobs list --workspace-id <id> --token <token> [--status running|terminal|all] [--session-id <id>] [--base-url <url>]
	jobs get --job-id <id> --token <token> [--base-url <url>]
	jobs abort --job-id <id> --token <token> [--base-url <url>]
	jobs stream --job-id <id> --token <token> [--base-url <url>]
	sessions list --workspace-id <id> --token <token> [--base-url <url>]
	sessions get --workspace-id <id> --session-id <id> --token <token> [--base-url <url>]
	sessions events --workspace-id <id> --session-id <id> --token <token> [--base-url <url>]
	previews list --workspace-id <id> --token <token> [--base-url <url>]
	previews revoke --workspace-id <id> --preview-id <id> --token <token> [--base-url <url>]
	agents list --workspace-id <id> --token <token> [--base-url <url>]
`;

if (import.meta.main) {
	const exitCode = await runCli(Bun.argv.slice(2), {
		fetch,
		stdout: { write: (chunk) => process.stdout.write(chunk) },
		stderr: { write: (chunk) => process.stderr.write(chunk) },
	});
	process.exit(exitCode);
}