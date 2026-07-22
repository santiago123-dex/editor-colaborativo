# Editor colaborativo

MVP de documentos colaborativos con React, Tiptap, Express, WebSocket binario, Yjs y SQLite.

## Requisitos

- Node.js 20 o superior
- npm

## Instalación y arranque

### Backend

```bash
cd backend
npm install
npm run dev
```

El servidor escucha en `http://localhost:3000` y crea `editor-colaborativo.sqlite` en el directorio actual. Se puede configurar con:

```bash
PORT=4000 DATABASE_PATH=/tmp/editor.sqlite npm start
```

`npm run dev` reinicia al detectar cambios. `npm start` ejecuta el servidor sin modo watch. CORS está habilitado para que un frontend en otro origen consuma la API.

### Frontend

En otra terminal:

```bash
cd frontend
npm install
npm run dev
```

Vite muestra la URL local, normalmente `http://localhost:5173`. El frontend usa el backend en el puerto `3000` por defecto. Para apuntar a otro puerto, copiá `frontend/.env.example` como `frontend/.env.local` y modificá ambas variables:

```dotenv
VITE_API_URL=http://localhost:4000
VITE_WS_URL=ws://localhost:4000/ws
```

Reiniciá Vite después de cambiar variables de entorno.

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

El contenido corresponde al `Y.Text` compartido llamado `document-content`.

## WebSocket y Yjs

La URL de colaboración es `ws://localhost:3000/ws/<documentId>`. Sólo acepta mensajes binarios estándar de `y-protocols/sync`; una consola WebSocket genérica no alcanza porque debe codificar y responder el protocolo de sincronización Yjs.

Con el backend en ejecución, este cliente verificable crea un documento, escribe mediante Yjs, desconecta la sala y comprueba la persistencia al reconectarse:

```bash
cd backend
npm run ws:smoke
```

Para otro host se puede usar `BASE_URL=http://localhost:4000 npm run ws:smoke`. La implementación completa del cliente está en `backend/scripts/ws-smoke.ts` y sirve como referencia de integración.

## Verificación

Backend:

```bash
cd backend
npm test
npm run typecheck
```

Los tests usan Vitest, Supertest, clientes `ws` reales y SQLite en memoria. Cubren el contrato REST, respuestas 404, rechazo de upgrades para documentos inexistentes, sincronización binaria entre dos clientes y persistencia al reabrir una sala.

Frontend:

```bash
cd frontend
npm test
npm run typecheck
```

### Probar colaboración en tiempo real

1. Levantá el backend y el frontend en terminales separadas.
2. Abrí la URL de Vite y creá un documento con **Nuevo documento**.
3. Copiá la URL `/documents/<id>` y abrila en una segunda pestaña.
4. Esperá a que ambas pestañas indiquen **Conectado**.
5. Escribí en cualquiera de las pestañas: el texto debe aparecer en la otra sin recargar.
6. Cerrá ambas pestañas, volvé a abrir el mismo documento y comprobá que el contenido persiste.

Tiptap guarda texto enriquecido en un `Y.XmlFragment`. El backend persiste correctamente el estado Yjs completo, pero actualmente `GET /documents/:id` intenta leer un `Y.Text` llamado `document-content`; por eso su campo `content` puede quedar vacío aunque el editor colaborativo sí sincronice y conserve el documento.
