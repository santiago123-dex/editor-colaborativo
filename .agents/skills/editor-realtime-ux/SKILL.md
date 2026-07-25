---
name: editor-realtime-ux
description: >
  Project-specific UX guidance for realtime collaboration states such as presence, participants, save status, reconnecting, chat, and conflict-safe feedback.
  Trigger: Use when changing collaborative UI states, participant indicators, save/reconnect messaging, chat UX, or editor status copy.
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## When to Use

- Changing `Editor`, `Participants`, `ChatPanel`, save indicators, or connection banners.
- Adding realtime feedback for connecting, reconnecting, offline, saved, saving, or error states.
- Designing UI around other users' presence, carets, chat, or document activity.

## Critical Patterns

| UX Area | Rule |
| --- | --- |
| Save state | Never claim “Guardado” until the durable ACK covers the current editor state. |
| Stale state | If a save ACK is stale, keep the UI in saving/pending rather than showing success. |
| Reconnect | Reconnection should be visible but not alarming unless work is at risk. |
| Presence | Show participants as collaborators, not as low-level awareness clients. |
| Chat | Chat must not imply document content was changed unless it was. |
| Copy | Use plain, actionable Spanish UI copy. Avoid vague errors like “Algo salió mal”. |
| Motion | Respect reduced motion and avoid distracting animations near active typing. |

## State Copy Guide

| State | Suggested copy |
| --- | --- |
| Connecting | `Conectando…` |
| Saving | `Guardando…` |
| Durable saved | `Guardado` |
| Reconnecting | `Reconectando…` |
| Retryable save error | `No se pudo guardar. Reintentando…` |
| Offline risk | `Sin conexión. Tus cambios se sincronizarán al volver.` |

## Implementation Checklist

1. Map each realtime status to one visible, non-conflicting message.
2. Confirm whether the state is optimistic, confirmed, stale, or failed.
3. Avoid interrupting typing with layout shifts or focus changes.
4. Test status transitions that happen quickly or out of order.

## Code Examples

```tsx
const labelByState = {
  saving: 'Guardando…',
  saved: 'Guardado',
  error: 'No se pudo guardar. Reintentando…',
}
```

```css
@media (prefers-reduced-motion: reduce) {
  .status-indicator {
    transition: none;
  }
}
```

## Commands

```bash
cd frontend
pnpm test
pnpm typecheck
```

