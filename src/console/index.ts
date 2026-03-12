export const consoleEntryPath = "/console";

export const renderConsoleHtml = (): string => `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>OR3 Net Console</title>
		<style>
			:root { color-scheme: dark; }
			body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0b1020; color: #e5ecff; }
			main { max-width: 1100px; margin: 0 auto; padding: 24px; }
			h1, h2 { margin: 0 0 12px; }
			.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
			.card { background: #141b34; border: 1px solid #253159; border-radius: 12px; padding: 16px; }
			label { display: block; font-size: 12px; margin-bottom: 6px; color: #9fb3ff; }
			input, textarea, select { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid #31406f; background: #0f1730; color: #f6f8ff; margin-bottom: 10px; }
			textarea { min-height: 90px; }
			button { padding: 10px 12px; border-radius: 8px; border: 1px solid #4762b1; background: #29408a; color: white; cursor: pointer; margin-right: 8px; margin-bottom: 8px; }
			button.secondary { background: #18254d; }
			pre { white-space: pre-wrap; word-break: break-word; background: #09101f; padding: 12px; border-radius: 8px; border: 1px solid #203055; min-height: 80px; }
			.actions { display: flex; flex-wrap: wrap; gap: 8px; }
		</style>
	</head>
	<body>
		<main>
			<h1>OR3 Net Console</h1>
			<p>Minimal authenticated operator console for jobs, nodes, API keys, sessions, previews, and service actions.</p>
			<div class="grid">
				<section class="card">
					<h2>Session</h2>
					<label for="baseUrl">Base URL</label>
					<input id="baseUrl" value="http://127.0.0.1:3001" />
					<label for="workspaceId">Workspace ID</label>
					<input id="workspaceId" value="ws_demo" />
					<label for="token">Workspace token or API key</label>
					<textarea id="token"></textarea>
					<div class="actions">
						<button id="loadJobs">List Jobs</button>
						<button id="loadNodes">List Nodes</button>
						<button id="loadApiKeys" class="secondary">List API Keys</button>
						<button id="loadSessions" class="secondary">List Sessions</button>
						<button id="loadAgents" class="secondary">List Agents</button>
						<button id="loadPreviews" class="secondary">List Previews</button>
					</div>
				</section>
				<section class="card">
					<h2>Jobs</h2>
					<label for="sessionKey">Session key</label>
					<input id="sessionKey" value="svc:console" />
					<label for="clientSessionId">Client session ID</label>
					<input id="clientSessionId" value="thread_console" />
					<label for="jobMessage">Message</label>
					<textarea id="jobMessage">say hello from the console</textarea>
					<div class="actions">
						<button id="submitJob">Submit Job</button>
						<button id="loadSessionEvents" class="secondary">Load Session Events</button>
					</div>
				</section>
				<section class="card">
					<h2>API Keys</h2>
					<label for="apiKeyName">Key name</label>
					<input id="apiKeyName" value="console-operator" />
					<label for="apiKeyScopes">Scopes (comma-separated)</label>
					<input id="apiKeyScopes" value="jobs:read,jobs:write" />
					<div class="actions">
						<button id="createApiKey">Create API Key</button>
						<button id="loadApiKeysPanel" class="secondary">Refresh API Keys</button>
					</div>
				</section>
				<section class="card">
					<h2>Sessions</h2>
					<label for="sessionId">Network session ID</label>
					<input id="sessionId" value="" />
					<div class="actions">
						<button id="loadSessionDetail">Load Session</button>
						<button id="loadSessionsPanel" class="secondary">Refresh Sessions</button>
					</div>
				</section>
				<section class="card">
					<h2>Service Actions</h2>
					<label for="nodeId">Node ID</label>
					<input id="nodeId" value="node_service" />
					<label for="serviceId">Service ID</label>
					<input id="serviceId" value="openclaw" />
					<div class="actions">
						<button id="openDashboard">Open Dashboard</button>
						<button id="revokeAccess" class="secondary">Revoke Access</button>
						<button id="restartService" class="secondary">Restart Service</button>
					</div>
				</section>
				<section class="card">
					<h2>Output</h2>
					<pre id="output">Ready.</pre>
				</section>
			</div>
		</main>
		<script>
			const output = document.getElementById('output');
			const getConfig = () => ({
				baseUrl: document.getElementById('baseUrl').value,
				workspaceId: document.getElementById('workspaceId').value,
				token: document.getElementById('token').value.trim(),
				nodeId: document.getElementById('nodeId').value,
				serviceId: document.getElementById('serviceId').value,
			});
			const headers = (withJson = false) => {
				const token = getConfig().token;
				return {
					...(token ? { Authorization: 'Bearer ' + token } : {}),
					...(withJson ? { 'Content-Type': 'application/json' } : {}),
				};
			};
			const write = (value) => { output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
			const call = async (path, init = {}) => {
				const response = await fetch(new URL(path, getConfig().baseUrl), { ...init, headers: { ...headers(init.body !== undefined), ...(init.headers || {}) } });
				const text = await response.text();
				try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: response.status, body: text }; }
			};

			document.getElementById('loadJobs').onclick = async () => {
				const { workspaceId } = getConfig();
				write(await call('/v1/workspaces/' + workspaceId + '/jobs'));
			};

			document.getElementById('loadNodes').onclick = async () => {
				const { workspaceId } = getConfig();
				write(await call('/v1/workspaces/' + workspaceId + '/nodes'));
			};
			document.getElementById('loadApiKeys').onclick = async () => {
				const { workspaceId } = getConfig();
				write(await call('/v1/workspaces/' + workspaceId + '/api-keys'));
			};
			document.getElementById('loadSessions').onclick = async () => {
				const { workspaceId } = getConfig();
				write(await call('/v1/workspaces/' + workspaceId + '/sessions'));
			};
			document.getElementById('loadAgents').onclick = async () => {
				const { workspaceId } = getConfig();
				write(await call('/v1/workspaces/' + workspaceId + '/agents'));
			};
			document.getElementById('loadPreviews').onclick = async () => {
				const { workspaceId } = getConfig();
				write(await call('/v1/workspaces/' + workspaceId + '/previews'));
			};
			document.getElementById('submitJob').onclick = async () => {
				const { workspaceId } = getConfig();
				write(await call('/v1/workspaces/' + workspaceId + '/jobs', {
					method: 'POST',
					body: JSON.stringify({
						client_kind: 'console',
						client_session_id: document.getElementById('clientSessionId').value,
						session_key: document.getElementById('sessionKey').value,
						message: document.getElementById('jobMessage').value,
					}),
				}));
			};
			document.getElementById('loadSessionEvents').onclick = async () => {
				const { workspaceId } = getConfig();
				const sessionId = document.getElementById('sessionId').value;
				write(await call('/v1/workspaces/' + workspaceId + '/sessions/' + sessionId + '/events'));
			};
			document.getElementById('createApiKey').onclick = async () => {
				const { workspaceId } = getConfig();
				write(await call('/v1/workspaces/' + workspaceId + '/api-keys', {
					method: 'POST',
					body: JSON.stringify({
						name: document.getElementById('apiKeyName').value,
						scopes: document.getElementById('apiKeyScopes').value.split(',').map((item) => item.trim()).filter(Boolean),
					}),
				}));
			};
			document.getElementById('loadApiKeysPanel').onclick = async () => {
				const { workspaceId } = getConfig();
				write(await call('/v1/workspaces/' + workspaceId + '/api-keys'));
			};
			document.getElementById('loadSessionDetail').onclick = async () => {
				const { workspaceId } = getConfig();
				const sessionId = document.getElementById('sessionId').value;
				write(await call('/v1/workspaces/' + workspaceId + '/sessions/' + sessionId));
			};
			document.getElementById('loadSessionsPanel').onclick = async () => {
				const { workspaceId } = getConfig();
				write(await call('/v1/workspaces/' + workspaceId + '/sessions'));
			};
			document.getElementById('openDashboard').onclick = async () => {
				const { workspaceId, nodeId, serviceId } = getConfig();
				const result = await call('/v1/workspaces/' + workspaceId + '/nodes/' + nodeId + '/services/' + serviceId + '/launch', { method: 'POST' });
				write(result);
				if (result.status === 200 && result.body && result.body.launch_url) {
					window.open(result.body.launch_url.replace('https://or3.local', getConfig().baseUrl), '_blank', 'noopener');
				}
			};
			document.getElementById('revokeAccess').onclick = async () => {
				const { workspaceId, nodeId, serviceId } = getConfig();
				write(await call('/v1/workspaces/' + workspaceId + '/nodes/' + nodeId + '/services/' + serviceId + '/revoke', { method: 'POST' }));
			};
			document.getElementById('restartService').onclick = async () => {
				const { workspaceId, nodeId, serviceId } = getConfig();
				write(await call('/v1/workspaces/' + workspaceId + '/nodes/' + nodeId + '/services/' + serviceId + '/restart', { method: 'POST' }));
			};
		</script>
	</body>
</html>`;