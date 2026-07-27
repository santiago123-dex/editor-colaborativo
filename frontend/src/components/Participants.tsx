import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'

interface AwarenessLike {
  getStates: () => Map<number, unknown>
  on: (event: 'change', handler: () => void) => void
  off: (event: 'change', handler: () => void) => void
}

interface Participant {
  clientId: number
  name: string
  color: string
}

const FALLBACK_COLOR = '#5f6652'

function readParticipants(awareness: AwarenessLike): Participant[] {
  const participants: Participant[] = []
  for (const [clientId, state] of awareness.getStates()) {
    if (!state || typeof state !== 'object' || !('user' in state)) continue
    const user = state.user
    if (!user || typeof user !== 'object' || !('name' in user) || !('color' in user)) continue
    if (typeof user.name !== 'string') continue
    const name = user.name.trim().slice(0, 40)
    if (!name) continue
    const color = typeof user.color === 'string' && /^#[0-9a-f]{6}$/i.test(user.color)
      ? user.color
      : FALLBACK_COLOR
    participants.push({ clientId, name, color })
  }
  return participants.sort((left, right) => left.name.localeCompare(right.name))
}

export function Participants({ awareness }: { awareness: AwarenessLike }) {
  const [participants, setParticipants] = useState(() => readParticipants(awareness))
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const update = () => setParticipants(readParticipants(awareness))
    awareness.on('change', update)
    update()
    return () => awareness.off('change', update)
  }, [awareness])

  useEffect(() => {
    if (!expanded) return
    const closeFromOutside = (event: MouseEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return
      setExpanded(false)
      toggleRef.current?.focus()
    }
    document.addEventListener('mousedown', closeFromOutside)
    return () => document.removeEventListener('mousedown', closeFromOutside)
  }, [expanded])

  function closeDisclosure() {
    setExpanded(false)
    toggleRef.current?.focus()
  }

  const countLabel = participants.length === 1
    ? '1 participante conectado'
    : `${participants.length} participantes conectados`

  return (
    <div ref={containerRef} className="participants">
      <button
        ref={toggleRef}
        className="participants__toggle"
        type="button"
        aria-label={countLabel}
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="participants__faces" aria-hidden="true">
          {participants.slice(0, 3).map((participant) => (
            <span key={participant.clientId} style={{ '--participant-color': participant.color } as CSSProperties}>
              {participant.name.slice(0, 1).toLocaleUpperCase()}
            </span>
          ))}
        </span>
        <span>{participants.length}</span>
      </button>
      {expanded && (
        <ul
          id={listId}
          className="participants__list"
          aria-label="Participantes conectados"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            closeDisclosure()
          }}
        >
          {participants.map((participant) => (
            <li key={participant.clientId}>
              <span style={{ '--participant-color': participant.color } as CSSProperties} aria-hidden="true" />
              {participant.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
