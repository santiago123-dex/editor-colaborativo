---
name: editor-frontend-architecture
description: >
  Project-specific frontend architecture guidance for the React, Vite, TypeScript collaborative editor app.
  Trigger: Use when adding screens, refactoring components, introducing hooks/context, or changing module boundaries in the frontend.
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## When to Use

- Adding or reshaping React components in `frontend/src/components/`.
- Introducing hooks, contexts, reducers, or shared utilities.
- Moving logic between UI, API, auth, chat, and collaboration modules.
- Refactoring `frontend/src/App.tsx` or cross-component state.

## Critical Patterns

| Concern | Rule |
| --- | --- |
| Module boundaries | Keep network contracts in `src/api`, auth in `src/auth`, realtime collaboration in `src/collaboration`, and UI in `src/components`. |
| Component size | Keep components focused on one user-facing responsibility. Extract helpers when behavior becomes reusable. |
| Side effects | Put subscriptions, sockets, timers, and external resources behind explicit lifecycle cleanup. |
| State ownership | Store state at the lowest level that needs it; lift only when multiple components coordinate. |
| Types | Prefer explicit domain types at API and component boundaries. |
| Environment | Read `import.meta.env` in boundary modules, not scattered through UI. |
| Styling | Keep class names semantic and avoid CSS selector collisions in `src/styles.css`. |

## Decision Table

| Need | Preferred place |
| --- | --- |
| REST call | `frontend/src/api/*.ts` |
| Auth session behavior | `frontend/src/auth/` |
| WebSocket/Yjs durable collaboration | `frontend/src/collaboration/` plus `Editor.tsx` integration |
| Pure display/control UI | `frontend/src/components/` |
| Shared test setup | `frontend/src/test/setup.ts` |

## Code Examples

```ts
// Good: API boundary owns fetch details.
const documents = await listDocuments()
```

```tsx
// Good: UI receives typed data and callbacks.
<DocumentList documents={documents} onSelectDocument={setSelectedDocumentId} />
```

```tsx
// Avoid: unrelated env and network details embedded in leaf UI controls.
fetch(`${import.meta.env.VITE_API_URL}/documents`)
```

## Commands

```bash
cd frontend
pnpm typecheck
pnpm test
```

