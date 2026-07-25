---
name: editor-frontend-testing
description: >
  Project-specific frontend testing guidance for the collaborative editor app using Vitest, Testing Library, jsdom, React, Tiptap, and Yjs.
  Trigger: Use when adding or modifying frontend tests, React components, API clients, auth context, chat, collaboration, or editor behavior.
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## When to Use

- Adding or changing tests in `frontend/src/**/*.test.ts` or `frontend/src/**/*.test.tsx`.
- Changing components under `frontend/src/components/`.
- Changing API clients under `frontend/src/api/`.
- Changing auth, chat, presence, collaboration, or editor behavior.

## Critical Patterns

| Area | Rule |
| --- | --- |
| User behavior | Test visible behavior and user outcomes before implementation details. |
| Async UI | Use Testing Library async utilities for network, state, and lifecycle updates. |
| Tiptap/Yjs | Mock editor/provider boundaries when the real dependency would make a unit test flaky. |
| Protocols | Cover binary collaboration, JSON chat, and REST clients separately. |
| Accessibility | Prefer queries by role, label, text, and accessible name. |
| Cleanup | Tests must not leak timers, sockets, globals, mocks, or DOM state. |
| Type safety | Run `pnpm typecheck` after meaningful TypeScript changes. |

## Test Coverage Checklist

1. Loading, empty, success, and error states.
2. Keyboard interactions for dialogs, forms, and editor-adjacent controls.
3. API failures with actionable UI feedback.
4. Session cleanup when document ID/auth state changes.
5. Collaboration-specific edge cases: reconnects, duplicate ACKs, stale ACKs, awareness updates.

## Code Examples

```tsx
render(<DocumentList />)
await screen.findByRole('button', { name: /nuevo documento/i })
```

```ts
afterEach(() => {
  vi.restoreAllMocks()
})
```

```ts
// Prefer explicit protocol-level assertions in API/client tests.
expect(request.url).toContain('/documents')
```

## Commands

```bash
cd frontend
pnpm test
pnpm typecheck
```

