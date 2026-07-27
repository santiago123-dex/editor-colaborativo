import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'

export function WordCount({ editor }: { editor: Editor }) {
  const [count, setCount] = useState(() => editor.storage.characterCount.words())

  useEffect(() => {
    const update = () => setCount(editor.storage.characterCount.words())
    editor.on('transaction', update)
    return () => editor.off('transaction', update)
  }, [editor])

  const label = count === 1 ? 'palabra' : 'palabras'

  return (
    <footer className="paper__footer" aria-label="Contador de palabras">
      {count} {label}
    </footer>
  )
}
