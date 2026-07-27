---
name: editor-tiptap-yjs-collaboration
description: >
  Project-specific guidance for changing the collaborative editor built with Tiptap, Yjs, y-websocket, awareness, and durable persistence.
  Trigger: Use when editing frontend collaboration code, Tiptap extensions, Yjs providers/documents, presence, carets, save state, or WebSocket collaboration flows.
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## When to Use

- Editing `frontend/src/components/Editor.tsx`.
- Changing collaboration modules under `frontend/src/collaboration/`.
- Touching Tiptap extensions, Yjs documents, providers, awareness, carets, word count, tasks, links, or placeholders.
- Modifying durable-save status, reconnect behavior, document switching, or collaboration WebSocket URLs.

## Critical Patterns

| Area | Rule |
| --- | --- |
| Protocol | Keep `/ws/<documentId>` as a binary Yjs WebSocket channel. Do not send ad-hoc JSON over it. |
| Presence | Use standard Yjs awareness for presence/carets. Do not invent a custom presence protocol. |
| Lifecycle | Destroy the previous collaborative session when the document ID or connection identity changes. |
| Initialization | Wait for valid document metadata before creating the collaborative editor session. |
| Auth loading | The editor may load collaboration while auth is loading, but title/document mutations must stay disabled until allowed. |
| Durable save | Only show a final “Guardado” state when the durable ACK covers the current state vector. |
| Errors | Treat durability errors as retryable unless the code explicitly proves otherwise. |
| Extensions | Configure links safely and keep task-list behavior compatible with nested task items. |
| Re-renders | Avoid remounting the editor/provider for unrelated UI state changes. |

## Implementation Checklist

1. Confirm whether the change belongs in UI, collaboration protocol, or API contract.
2. Preserve the existing Yjs binary protocol unless a backend contract has been documented first.
3. Ensure cleanup calls destroy providers, editors, listeners, timers, and controllers.
4. Verify document switches do not leak awareness state or old WebSocket connections.
5. Add or update tests that cover lifecycle, reconnection, save state, and extension configuration.

## Code Examples

```ts
// Good: derive the collaboration room URL from the document ID.
const roomUrl = `${collaborationBaseUrl.replace(/\/$/, '')}/${documentId}`
```

```ts
// Good: guard durable-save UI with the protocol response rather than optimistic text.
if (ackCoversCurrentState) {
  setPersistenceState('saved')
}
```

```ts
// Avoid: JSON messages on the Yjs binary channel.
provider.ws?.send(JSON.stringify({ type: 'presence' }))
```

## Commands

```bash
cd frontend
pnpm test
pnpm typecheck
```

