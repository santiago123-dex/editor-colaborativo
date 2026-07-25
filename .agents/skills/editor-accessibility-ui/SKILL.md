---
name: editor-accessibility-ui
description: >
  Project-specific accessibility and interaction guidance for the collaborative editor frontend.
  Trigger: Use when changing dialogs, buttons, forms, document lists, auth controls, sharing UI, chat, keyboard interactions, focus management, or visual states.
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## When to Use

- Editing `DocumentList`, `AuthControls`, `ShareDocumentButton`, `ChatPanel`, `Participants`, or editor-adjacent controls.
- Adding dialogs, popovers, forms, buttons, menus, or status messages.
- Changing keyboard behavior, focus styles, color contrast, or disabled/loading states.

## Critical Patterns

| Area | Rule |
| --- | --- |
| Focus | Keep visible focus for every interactive control. Do not remove outlines without replacement. |
| Keyboard | Dialogs and popovers must support Escape to close and sensible Enter/Tab behavior. |
| Labels | Inputs and icon-only buttons need accessible names. |
| Disabled/loading | Disabled states must communicate why action is unavailable when context is not obvious. |
| Errors | Error messages should identify the problem and the next action. |
| Status | Use ARIA live regions for async status when the text is important and not already focused. |
| Contrast | Verify text, focus rings, status pills, and caret labels remain legible. |

## UI Checklist

1. Can the flow be completed with keyboard only?
2. Is the focused element always visible?
3. Do controls have role/name/state that match their visual purpose?
4. Are loading and error states announced or visible in context?
5. Do dialogs return focus to the opener when closed?
6. Does copy use clear Spanish action verbs?

## Code Examples

```tsx
<button type="button" aria-label="Compartir documento">
  Compartir
</button>
```

```tsx
<p role="status" aria-live="polite">
  Guardando…
</p>
```

```css
.button:focus-visible {
  outline: 3px solid var(--focus-ring);
  outline-offset: 2px;
}
```

## Commands

```bash
cd frontend
pnpm test
pnpm typecheck
```

