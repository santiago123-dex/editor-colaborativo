# Roadmap de funcionalidades

Este documento divide el trabajo entre backend y frontend para poder ejecutar mejoras en paralelo sin inventar contratos entre ambos lados.

## Convenciones

- `BE-*`: tarea de backend.
- `FE-*`: tarea de frontend.
- Una tarea se marca como completada sólo después de implementar sus pruebas y documentación.
- Si una tarea frontend depende de backend, primero se acuerda y documenta el contrato.
- No se debe mostrar "Guardado" si el servidor todavía no confirmó persistencia durable.

## Definition of Done

Cada tarea debe cumplir:

- [ ] Comportamiento implementado.
- [ ] Pruebas automatizadas aprobadas.
- [ ] Typecheck aprobado.
- [ ] Estados de carga, error y vacío contemplados.
- [ ] Navegación por teclado y labels accesibles cuando exista interfaz.
- [ ] Contrato o decisión técnica documentada.
- [ ] Sin regresiones en colaboración, editor ni chat.

## Sprint recomendado

Estado auditado contra el código el 22 de julio de 2026.

### Backend

- [x] **BE-01** Persistir updates Yjs de forma incremental.
- [x] **BE-02** Confirmar al cliente cuándo los cambios son durables.
- [x] **BE-03** Probar recuperación después de reinicios y desconexiones.
- [x] **BE-04** Implementar la base del protocolo awareness.

### Frontend

- [x] **FE-01** Agregar UX de reconexión sin bloquear la edición.
- [x] **FE-02** Agregar botón para copiar el enlace del documento.
- [x] **FE-03** Agregar links al editor.
- [x] **FE-04** Agregar checklist al editor.
- [x] **FE-05** Agregar contador de palabras.
- [x] **FE-06** Preparar estados de persistencia contra el contrato de BE-02.

---

## Etapa 1: persistencia y confiabilidad

### Backend

- [x] **BE-01** Persistir updates Yjs con debounce.
- [x] **BE-02** Enviar confirmación de persistencia durable.
- [x] **BE-03** Recuperar correctamente salas después de reiniciar el servidor.
- [x] **BE-05** Definir política de reintentos ante errores SQLite.
- [ ] **BE-06** Probar caída, reconexión y recuperación del documento.
- [x] **BE-07** Probar que abrir y cerrar sin editar no modifica `updatedAt`.

### Frontend

- [x] **FE-06** Mostrar "Cambios pendientes" cuando corresponda. Depende de BE-02.
- [x] **FE-07** Mostrar "Guardado" sólo después de confirmación durable. Depende de BE-02.
- [x] **FE-08** Mostrar errores de persistencia con acción de reintento. Depende de BE-02.
- [x] **FE-01** Mantener el documento editable durante reconexiones.
- [x] **FE-09** Diferenciar conexión, sincronización y persistencia.

### Contrato implementado

- [x] Definir cómo el backend identifica y confirma updates persistidos.
- [x] Definir si la confirmación se envía por el WebSocket Yjs o por un canal separado.
- [x] Definir cuándo debe actualizarse `updatedAt`.

El frontend usa el mensaje binario tipo `4`, un `requestId` de 16 bytes y el state vector actual. Sólo muestra "Guardado" cuando el ACK durable cubre el estado vigente; los errores reintentables generan una solicitud nueva.

---

## Etapa 2: presencia y cursores

### Backend

- [x] **BE-04** Implementar `awareness` estándar de Yjs.
- [x] **BE-08** Hacer broadcast de awareness dentro de cada sala.
- [x] **BE-09** Limpiar estados de awareness al desconectar clientes.
- [x] **BE-10** Probar presencia con dos `WebsocketProvider` reales.
- [x] **BE-11** Probar limpieza tras una desconexión abrupta.

### Frontend

- [x] **FE-10** Generar nombre y color para la identidad local.
- [x] **FE-11** Configurar awareness en el provider. Depende de BE-04.
- [x] **FE-12** Mostrar usuarios conectados. Depende de BE-04.
- [x] **FE-13** Mostrar cursores y selecciones remotas. Depende de BE-04.
- [x] **FE-14** Diseñar una vista compacta de colaboradores para móvil.

### Restricción

No crear un protocolo JSON propio para presencia. Se debe utilizar el protocolo awareness de Yjs.

---

## Etapa 3: compartir documentos

### Frontend disponible ahora

- [x] **FE-02** Agregar botón "Copiar enlace".
- [x] **FE-15** Mostrar confirmación "Enlace copiado".
- [x] **FE-16** Manejar errores del portapapeles.

### Backend

- [ ] **BE-12** Crear modelo de permisos por documento.
- [ ] **BE-13** Agregar roles `viewer` y `editor`.
- [ ] **BE-14** Validar permisos en REST.
- [ ] **BE-15** Validar permisos durante el upgrade WebSocket.
- [ ] **BE-16** Probar accesos permitidos y denegados.

### Frontend dependiente

- [ ] **FE-17** Crear panel para compartir. Depende de BE-12.
- [ ] **FE-18** Agregar vista de sólo lectura. Depende de BE-13.
- [ ] **FE-19** Mostrar estados 401 y 403. Depende de BE-14.

---

## Etapa 4: organización de documentos

### Backend

- [ ] **BE-17** Agregar favoritos.
- [ ] **BE-18** Agregar etiquetas.
- [ ] **BE-19** Agregar carpetas.
- [ ] **BE-20** Implementar papelera mediante `deletedAt`.
- [ ] **BE-21** Restaurar documentos eliminados.
- [ ] **BE-22** Eliminar documentos definitivamente.
- [ ] **BE-23** Duplicar documento y snapshot Yjs.
- [ ] **BE-24** Agregar endpoint de documentos recientes.
- [ ] **BE-25** Crear migraciones y pruebas del nuevo esquema.

### Frontend

- [ ] **FE-20** Marcar y filtrar favoritos. Depende de BE-17.
- [ ] **FE-21** Filtrar por etiquetas. Depende de BE-18.
- [ ] **FE-22** Navegar por carpetas. Depende de BE-19.
- [ ] **FE-23** Crear pantalla de papelera. Depende de BE-20.
- [ ] **FE-24** Restaurar documentos. Depende de BE-21.
- [x] **FE-25** Confirmar eliminación definitiva. Depende de BE-22.
- [ ] **FE-26** Agregar acción "Duplicar". Depende de BE-23.
- [ ] **FE-27** Crear sección "Recientes". Depende de BE-24.

### Orden recomendado

1. Favoritos.
2. Papelera.
3. Duplicación.
4. Etiquetas.
5. Carpetas.

---

## Etapa 5: formato y experiencia del editor

Estas tareas son frontend y pueden desarrollarse sin ampliar el backend.

- [x] **FE-03** Links.
- [x] **FE-04** Checklist.
- [ ] **FE-28** Resaltado.
- [ ] **FE-29** Separador horizontal.
- [ ] **FE-30** Alineación de texto.
- [x] **FE-05** Contador de palabras.
- [ ] **FE-31** Menú flotante al seleccionar texto.
- [ ] **FE-32** Menú `/` para insertar bloques.
- [ ] **FE-33** Tema oscuro.
- [ ] **FE-34** Vista de ancho completo.
- [ ] **FE-35** Tooltips con atajos de teclado.

Todas las extensiones Tiptap deben configurarse de la misma forma en cada cliente.

---

## Etapa 6: trabajo offline

### Backend

- [ ] **BE-26** Definir política para documentos eliminados con cambios offline.
- [ ] **BE-27** Rechazar updates de documentos eliminados.
- [ ] **BE-28** Resolver reconexiones de sesiones antiguas.
- [ ] **BE-29** Probar sincronización después de una desconexión prolongada.

### Frontend

- [ ] **FE-36** Integrar `y-indexeddb`. Depende de la política BE-26.
- [ ] **FE-37** Mostrar estado "Trabajando sin conexión".
- [ ] **FE-38** Sincronizar automáticamente al recuperar conexión.
- [ ] **FE-39** Limpiar caché de documentos eliminados. Depende de BE-26.
- [ ] **FE-40** Probar edición offline y reconexión.

---

## Etapa 7: historial de versiones

### Backend

- [ ] **BE-30** Crear modelo de snapshots.
- [ ] **BE-31** Generar snapshots periódicos.
- [ ] **BE-32** Listar versiones de un documento.
- [ ] **BE-33** Obtener una versión concreta.
- [ ] **BE-34** Restaurar una versión.
- [ ] **BE-35** Definir política de retención.
- [ ] **BE-36** Probar creación y restauración de snapshots.

### Frontend

- [ ] **FE-41** Crear panel de versiones. Depende de BE-32.
- [ ] **FE-42** Previsualizar una versión. Depende de BE-33.
- [ ] **FE-43** Mostrar fecha y autor de cada versión.
- [ ] **FE-44** Confirmar restauración. Depende de BE-34.
- [ ] **FE-45** Mostrar progreso y errores de restauración.

---

## Etapa 8: comentarios sobre el documento

### Backend

- [ ] **BE-37** Crear modelo de conversaciones.
- [ ] **BE-38** Persistir posiciones relativas de Yjs.
- [ ] **BE-39** Crear comentarios y respuestas.
- [ ] **BE-40** Resolver y reabrir comentarios.
- [ ] **BE-41** Sincronizar comentarios en tiempo real.
- [ ] **BE-42** Probar posiciones después de ediciones concurrentes.

### Frontend

- [ ] **FE-46** Comentar texto seleccionado. Depende de BE-37.
- [ ] **FE-47** Renderizar marcas de comentarios. Depende de BE-38.
- [ ] **FE-48** Crear panel lateral de conversaciones. Depende de BE-39.
- [ ] **FE-49** Responder comentarios. Depende de BE-39.
- [ ] **FE-50** Resolver y reabrir comentarios. Depende de BE-40.
- [ ] **FE-51** Navegar desde un comentario hasta su texto.

Las posiciones deben utilizar `Y.RelativePosition`. No se deben guardar offsets numéricos comunes.

---

## Etapa 9: mejoras del chat

### Backend

- [ ] **BE-43** Editar mensajes propios.
- [ ] **BE-44** Eliminar mensajes propios.
- [ ] **BE-45** Responder mensajes.
- [ ] **BE-46** Agregar reacciones.
- [ ] **BE-47** Paginar historial mediante cursor.
- [ ] **BE-48** Agregar rate limiting.
- [ ] **BE-49** Probar autorización, paginación e idempotencia.

### Frontend

- [ ] **FE-52** Editar mensajes. Depende de BE-43.
- [ ] **FE-53** Eliminar mensajes. Depende de BE-44.
- [ ] **FE-54** Responder mensajes. Depende de BE-45.
- [ ] **FE-55** Mostrar reacciones. Depende de BE-46.
- [ ] **FE-56** Cargar historial anterior. Depende de BE-47.
- [x] **FE-57** Agregar separadores por fecha.
- [x] **FE-58** Mejorar badges de mensajes no leídos.

---

## Etapa 10: autenticación y seguridad

### Backend

- [x] **BE-50** Registro e inicio de sesión.
- [x] **BE-51** Implementar sesiones o tokens.
- [x] **BE-52** Asociar propietario a cada documento.
- [ ] **BE-53** Implementar permisos por documento.
- [ ] **BE-54** Autorizar operaciones REST.
- [ ] **BE-55** Autorizar conexiones WebSocket.
- [x] **BE-56** Validar `Origin` en WebSocket.
- [ ] **BE-57** Aplicar rate limiting a REST y WebSocket.
- [ ] **BE-58** Registrar acciones sensibles.

### Frontend

- [x] **FE-59** Crear pantallas de autenticación. Depende de BE-50.
- [x] **FE-60** Manejar la sesión. Depende de BE-51.
- [ ] **FE-61** Proteger rutas. Depende de BE-51.
- [ ] **FE-62** Crear selector de permisos. Depende de BE-53.
- [ ] **FE-63** Manejar respuestas 401 y 403. Depende de BE-54.
- [x] **FE-64** Implementar cierre de sesión.

---

## Trabajo que puede comenzar en paralelo

### Equipo backend

1. BE-01: persistencia incremental.
2. BE-02: confirmación durable.
3. BE-04: awareness.
4. BE-17: favoritos.
5. BE-20: papelera.

### Equipo frontend

1. FE-01: UX de reconexión.
2. FE-02: copiar enlace.
3. FE-03: links.
4. FE-04: checklist.
5. FE-05: contador de palabras.
6. FE-57: separadores de fecha del chat.

## Funcionalidades postergadas

No comenzar estas tareas hasta consolidar persistencia, permisos y contratos:

- Carga de imágenes y archivos.
- IA generativa dentro del editor.
- Exportación avanzada a PDF.
- Notificaciones externas.
- Integraciones con servicios de terceros.

La prioridad es que el documento sea durable, recuperable, compartible y realmente colaborativo.
