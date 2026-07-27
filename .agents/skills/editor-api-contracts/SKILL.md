---
name: editor-api-contracts
description: >
  Project-specific guidance for frontend/backend contracts in the collaborative editor, covering REST, auth, chat WebSocket, Yjs WebSocket, and Vite environment variables.
  Trigger: Use when changing frontend API clients, WebSocket URLs, auth/session behavior, environment variables, or frontend code that depends on backend contracts.
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## When to Use

- Editing `frontend/src/api/*.ts`.
- Editing `frontend/src/chat/*.ts`.
- Changing `VITE_API_URL`, `VITE_WS_URL`, `VITE_CHAT_WS_URL`, `.env.example`, or README setup docs.
- Adding frontend behavior that requires a backend route, payload, status code, cookie, or WebSocket message.

## Critical Patterns

| Channel | Rule |
| --- | --- |
| REST | Keep document/auth HTTP behavior inside `frontend/src/api`. |
| Yjs WebSocket | `/ws/<documentId>` is binary Yjs sync/awareness plus documented private durability frames. |
| Chat WebSocket | `/ws/chat/<documentId>` is JSON and separate from Yjs collaboration. |
| Env vars | Document new `VITE_*` variables in `frontend/.env.example` and README. |
| Backend dependency | Do not invent a new contract in frontend without updating backend or documenting the agreed contract first. |
| Errors | Normalize user-facing errors; do not expose internal backend details. |
| Cookies/CORS | Auth/session changes must consider cross-origin cookie behavior and SameSite/Secure constraints. |

## Contract Change Checklist

1. Identify the channel: REST, Yjs WebSocket, chat WebSocket, or browser env.
2. Check README/ROADMAP for the current contract before coding.
3. Update backend and frontend together when the contract changes.
4. Add tests on the boundary module.
5. Update `.env.example` and README when configuration changes.

## Code Examples

```ts
// Good: chat URL defaults by appending /chat to the collaboration URL.
const base = (chatUrl ?? `${collaborationUrl.replace(/\/$/, '')}/chat`).replace(/\/$/, '')
```

```ts
// Good: keep API error handling behind the client.
throw new ApiError(response.status, message)
```

```ts
// Avoid: silently assuming a backend field exists without contract/test coverage.
const owner = response.createdBy.displayName
```

## Commands

```bash
cd frontend
pnpm test
pnpm typecheck
```

