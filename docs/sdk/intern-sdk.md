# Intern SDK

This guide explains the `sdk/intern` package and when to use it.

## What the Intern SDK is for

The Intern SDK is the TypeScript client for the internal turn-processing service used by OR3 Net.

Use it when you need to:

- submit a turn request
- stream incremental job output
- spawn a subagent
- attach to an existing job stream
- abort a running Intern job

The main implementation is `HttpInternClient` in [sdk/intern/client.ts](../../sdk/intern/client.ts).

## Core idea

The Intern SDK is not a general OR3 Net client.
It is a client for the **Intern service**.

That means it sits one layer closer to turn processing than the OR3 Net HTTP API does.

If you need workspace-level control-plane behavior, start with the OR3 Net HTTP API.
If you need direct turn and subagent operations against Intern, use this SDK.

## Main interface

The transport-neutral interface is `InternClient`.
It exposes:

- `submitTurn(...)`
- `submitTurnStream(...)`
- `spawnSubagent(...)`
- `streamJob(...)`
- `abortJob(...)`

## Authentication model

`HttpInternClient` signs a short-lived service bearer token from a shared secret.

Important implications:

- callers do not pass a long-lived workspace token to this SDK
- the SDK itself creates the bearer token used for each request
- the shared secret must match what the Intern service expects

## Request context propagation

Many Intern calls optionally carry request context headers.
These help preserve trace and workspace context.

The request context can include:

- `requestId`
- `workspaceId`
- `networkSessionId`

This is useful when OR3 Net is acting as the caller and wants Intern-side logs or tracing to line up with control-plane state.

## Common usage

### Submit a turn and wait for JSON

```ts
import { HttpInternClient } from 'or3-net/sdk/intern';

const client = new HttpInternClient({
  baseUrl: 'http://127.0.0.1:3000',
  secret: process.env.INTERN_SHARED_SECRET!,
});

const response = await client.submitTurn({
  sessionKey: 'svc:demo',
  message: 'say hello',
  requestContext: {
    requestId: 'req_demo',
    workspaceId: 'ws_demo',
  },
});
```

### Submit a turn and stream output

```ts
for await (const event of client.submitTurnStream({
  sessionKey: 'svc:demo',
  message: 'write a short summary',
})) {
  console.log(event.event, event.data);
}
```

### Spawn a subagent

```ts
const result = await client.spawnSubagent({
  parentSessionKey: 'svc:demo',
  task: 'Review the draft and list missing risks',
  promptSnapshot: [
    { role: 'user', content: 'Draft goes here' },
  ],
});
```

## Error handling

Failed HTTP calls are normalized into `InternRequestError`.

It includes:

- `status`
- optional parsed `response`
- optional `retryAfterMs`

This makes it easier to branch on capability or availability failures.

A helper is also provided:

- `isInternSubagentsUnavailable(error)`

Use it when subagents are optional rather than guaranteed.

## Streaming behavior

Streaming methods parse SSE frames using the standard pattern:

- `event: ...`
- `data: ...`

This is intentionally simple and easy to reason about.

Important constraint:

- if the response body is missing, the client throws instead of pretending the stream completed cleanly

## When not to use this SDK

Do not use the Intern SDK when you need:

- workspace API key management
- runtime session lifecycle
- preview management
- node enrollment or approval
- launch token resolution

Those are OR3 Net control-plane responsibilities, not Intern SDK responsibilities.

Use the OR3 Net HTTP API for those workflows.

## Related docs

- [HTTP API](../api/http-api.md)
- [Jobs and Sessions](../concepts/jobs-and-sessions.md)
