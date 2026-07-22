# Editor colaborativo

MVP de documentos colaborativos con React, Tiptap, Express, WebSocket binario, Yjs y SQLite.

## Requisitos

- Node.js 22
- pnpm 10

## Instalación y arranque

### Backend

```bash
cd backend
pnpm install
pnpm dev
```

El servidor escucha en `http://localhost:3000` y crea `editor-colaborativo.sqlite` en el directorio actual. Se puede configurar con:

```bash
PORT=4000 DATABASE_PATH=/tmp/editor.sqlite pnpm start
```

`pnpm dev` reinicia al detectar cambios. `pnpm start` ejecuta el servidor sin modo watch. CORS está habilitado para que un frontend en otro origen consuma la API.

### Frontend

En otra terminal:

```bash
cd frontend
pnpm install
pnpm dev
```

Vite muestra la URL local, normalmente `http://localhost:5173`. El frontend usa el backend en el puerto `3000` por defecto. Para apuntar a otro puerto, copiá `frontend/.env.example` como `frontend/.env.local` y modificá las variables:

```dotenv
VITE_API_URL=http://localhost:4000
VITE_WS_URL=ws://localhost:4000/ws
VITE_CHAT_WS_URL=ws://localhost:4000/ws/chat
```

`VITE_CHAT_WS_URL` es opcional: si falta, el frontend agrega `/chat` a `VITE_WS_URL`. Reiniciá Vite después de cambiar variables de entorno.

## API REST

Crear un documento:

```bash
curl -X POST http://localhost:3000/documents
```

Listar documentos:

```bash
curl http://localhost:3000/documents
```

Obtener un documento, reemplazando `<id>` por el UUID devuelto al crearlo:

```bash
curl http://localhost:3000/documents/<id>
```

Actualizar su título:

```bash
curl -X PATCH http://localhost:3000/documents/<id> \
  -H 'Content-Type: application/json' \
  -d '{"title":"Plan del proyecto"}'
```

Eliminarlo cuando no tenga una sala WebSocket activa:

```bash
curl -X DELETE http://localhost:3000/documents/<id>
```

La eliminación responde `204` al completarse, `404` si el documento no existe y `409` si todavía tiene clientes conectados. La lista y el detalle incluyen `title` y `updatedAt`; el detalle serializa el `Y.XmlFragment` usado por Tiptap y mantiene compatibilidad con el `Y.Text` `document-content` del cliente de prueba.

## WebSocket y Yjs

La URL de colaboración es `ws://localhost:3000/ws/<documentId>`. Sólo acepta mensajes binarios estándar de `y-protocols/sync`; una consola WebSocket genérica no alcanza porque debe codificar y responder el protocolo de sincronización Yjs.

Con el backend en ejecución, este cliente verificable crea un documento, escribe mediante Yjs, desconecta la sala y comprueba la persistencia al reconectarse:

```bash
cd backend
pnpm ws:smoke
```

Para otro host se puede usar `BASE_URL=http://localhost:4000 pnpm ws:smoke`. La implementación completa del cliente está en `backend/scripts/ws-smoke.ts` y sirve como referencia de integración.

## Chat en tiempo real

El historial se obtiene por REST, reemplazando `<id>` por el documento y usando un límite entre `1` y `50`:

```bash
curl 'http://localhost:3000/documents/<id>/messages?limit=50'
```

El chat usa un WebSocket JSON separado en `ws://localhost:3000/ws/chat/<documentId>`. Esto mantiene intacto el protocolo binario de Yjs en `/ws/<documentId>`.

El cliente envía:

```json
{
  "type": "message:create",
  "clientMessageId": "uuid-generado-por-el-cliente",
  "author": "Santiago",
  "content": "Hola"
}
```

El servidor persiste el mensaje antes de responder y emite `message:created` a toda la sala. `clientMessageId` hace que un reintento del mismo mensaje sea idempotente: no crea otra fila ni vuelve a notificar a los demás participantes.

El nombre es temporal y no representa una identidad autenticada. El backend normaliza espacios y admite nombres de hasta 40 caracteres y mensajes de hasta 1000 caracteres.

## Verificación

Backend:

```bash
cd backend
pnpm test
pnpm typecheck
```

Los tests usan Vitest, Supertest, clientes `ws` reales y SQLite en memoria. Cubren REST, migraciones, sincronización Yjs, chat entre clientes, idempotencia, límites de payload, heartbeat y persistencia.

Frontend:

```bash
cd frontend
pnpm test
pnpm typecheck
```

### Probar colaboración en tiempo real

1. Levantá el backend y el frontend en terminales separadas.
2. Abrí la URL de Vite y creá un documento con **Nuevo documento**.
3. Copiá la URL `/documents/<id>` y abrila en una segunda pestaña.
4. Esperá a que ambas pestañas indiquen **Conectado**.
5. Escribí en cualquiera de las pestañas: el texto debe aparecer en la otra sin recargar.
6. Cambiá el título y comprobá que la lista muestre el nombre y la última edición.
7. Cerrá ambas pestañas, volvé a abrir el mismo documento y comprobá que el contenido persiste.
8. Abrí el chat en ambas pestañas, elegí nombres diferentes y enviá mensajes en ambos sentidos.
9. Recargá una pestaña y comprobá que el historial reaparece sin mensajes duplicados.
10. Desde la lista, confirmá que el documento puede eliminarse cuando ya no tiene clientes conectados.
