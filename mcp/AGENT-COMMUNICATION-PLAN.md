# Plan: comunicación entre agentes con fAir Drop MCP

Estado: núcleo implementado en 1.2.0. Incluye herramientas, TLS 1.3 PSK,
bandeja local durable, recibos, reintentos, adjuntos y recuperación. Se agregó
`fairdrop_agent_resume`; `fairdrop_agent_status` sin argumentos descubre sesiones
del proyecto tras un reinicio. Ver README para el contrato efectivo y configuración.

Pruebas: clientes independientes MCP SDK/JSON-RPC por P2P y relay, signaling real
y smoke test contra el WSS alojado. Las GUIs y turnos de modelos de los cinco
arneses no se ejecutaron en esta máquina. Los adaptadores para despertar un
agente inactivo siguen siendo una fase opcional, no parte del núcleo común.

## Objetivo y alcance

Permitir que dos agentes intercambien texto, JSON, resultados, preguntas y
archivos entre proyectos o máquinas. Ejemplos: Codex en el VPS y un agente en
la máquina local, o Claude Code en un repositorio y OpenCode en otro.

Cada arnés arranca su MCP local por stdio. Ambos MCP conectan al mismo servidor
fAir Drop con WebSocket saliente; no requieren abrir puertos entrantes en las
máquinas de los agentes. El servidor sigue teniendo salas en memoria y solo
reenvía signaling y relay. Los mensajes y archivos se conservan en los extremos.

El contrato público será MCP estándar, con herramientas y esquemas JSON. No
dependerá de un modelo, de una API de generación ni de una skill específica.
Codex, OpenCode, Claude Code, VS Code y Cursor son objetivos de compatibilidad;
la configuración y los límites de espera se verificarán en cada cliente antes
de declarar soporte probado.

## Lo que ya permite el MCP

Dos agentes ya pueden transferir archivos: A llama a `fairdrop_create_session`,
B se une con `fairdrop_receive_session`, y ambos consultan o esperan su sesión.
Un archivo JSON o Markdown permite compartir información hoy. Para responder,
B necesita crear otra sala de envío y compartir su código con A.

Esto todavía no constituye una conversación: las sesiones de envío terminan
tras la transferencia, no hay bandeja de mensajes ni un canal bidireccional
de larga duración. `received` confirma un archivo guardado; no que el agente
lo haya leído o ejecutado una tarea.

## Herramientas propuestas

| Herramienta | Función y parámetros principales |
| --- | --- |
| `fairdrop_agent_create` | Abre una sala bidireccional; recibe un alias y un nombre de proyecto opcional. Devuelve `session_id`, código e invitación privada. |
| `fairdrop_agent_join` | Se une con `code` de ocho caracteres (o invitación heredada) y presenta su alias. Devuelve su propio `session_id` y el estado del emparejamiento. |
| `fairdrop_agent_send` | Envía texto o JSON y adjuntos locales opcionales a `session_id`. Acepta `message_id` para reintentar y `reply_to` para responder. |
| `fairdrop_agent_inbox` | Devuelve mensajes sin leer, o mensajes posteriores a un cursor; paginación y límite de resultados. Consultar no marca lectura. |
| `fairdrop_agent_wait_message` | Espera mensajes posteriores a un cursor, cierre o timeout. Devuelve el mismo formato que `inbox`. |
| `fairdrop_agent_ack` | Confirma que el agente consumió uno o varios mensajes. Solo esta llamada marca `read`. |
| `fairdrop_agent_status` | Devuelve conexión, transporte, peer y estados de mensajes enviados. Permite consultar un `message_id` concreto. |
| `fairdrop_agent_close` | Cierra el canal y notifica al otro extremo; conserva el historial local según su política de retención. |

Cada herramienta llevará una descripción autosuficiente, los parámetros
obligatorios, ejemplos y errores claros. El servidor incluirá instrucciones
generales de uso durante la inicialización. El flujo esencial también estará
en las descripciones, porque el soporte de instrucciones y prompts varía por
arnés. README y una posible skill serán ayudas, no requisitos.

`session_id` será un UUID local independiente del código de sala. Evita que
reutilizar un código corto confunda conversaciones. Cada proceso conserva sus
sesiones; dos agentes en la misma máquina no comparten bandeja por defecto.

## Cómo sabe un agente que llegó algo

La bandeja es explícita. Si el receptor está trabajando, llama a `inbox` en los
puntos definidos por su tarea. Si espera una respuesta, llama a `wait_message`.
El MCP escucha la red incluso entre llamadas y almacena los mensajes recibidos.

Ejemplo de resultado de `wait_message`:

```json
{
  "session_id": "local-session-uuid",
  "state": "connected",
  "messages": [{
    "message_id": "message-uuid",
    "sequence": 12,
    "from": { "alias": "agente-vps", "project": "fAir-Drop" },
    "received_at": "2026-10-13T12:00:00Z",
    "kind": "result",
    "body": { "text": "Los tests pasaron. Adjunto el parche." },
    "attachments": [],
    "reply_to": "previous-message-uuid",
    "read": false
  }],
  "next_cursor": "12"
}
```

Los alias son etiquetas declaradas por los peers; la autenticación pertenece
al emparejamiento. Las rutas de adjuntos que se devuelvan serán rutas creadas
por el receptor en su máquina, nunca rutas arbitrarias elegidas por el peer.

La espera tendrá un timeout corto configurable, inicialmente 25 segundos,
para encajar en límites habituales del cliente. Si vence, devuelve una lista
vacía y un estado inequívoco. El agente puede repetirla mientras esté en una
tarea de espera autorizada. No se prometen esperas ilimitadas ni compatibilidad
con un timeout de 240 segundos en todos los arneses.

## Entrega, lectura y respuesta

| Estado | Evidencia |
| --- | --- |
| `pending` | Mensaje validado y guardado en la bandeja de salida local. |
| `delivered` | MCP remoto autenticado confirmó que guardó el mensaje completo, incluidos sus adjuntos. |
| `read` | Agente receptor llamó a `ack`; es una confirmación explícita, no una prueba de comprensión. |
| `replied` | Llegó una respuesta que referencia el mensaje con `reply_to`. |
| `failed` / `expired` | Error definitivo o vencimiento del plazo de entrega. |

Estos recibos son mensajes del protocolo entre los extremos. El sender no
confunde un `ws.send()` exitoso con entrega. `delivered` no garantiza que el
agente vaya a responder ni que haya completado la tarea solicitada.

Leer una lista no elimina mensajes. `ack` es idempotente. Un cursor estable y
los IDs evitan perder mensajes si el arnés cancela una espera, trunca una salida
o repite una llamada. La bandeja limita el tamaño de cada respuesta.

## Protocolo y almacenamiento

Se usan sobres versionados `agent-hello`, `agent-message`, `agent-receipt` y
`agent-close`. Los sobres de aplicación y los chunks de adjuntos están dentro
de TLS 1.3; en relay se transporta el ciphertext mediante `agent-wire` dentro
de `relay-meta`, y en P2P mediante binarios del DataChannel. El servidor no
interpreta el contenido. Solo la negociación de capacidades/transporte es pública.

Negociar versión y capacidades antes de habilitar envíos. Un navegador o MCP
antiguo sin soporte de agentes debe producir `unsupported_peer`, sin enviarle
mensajes que no entiende. Mantener intactos los flujos web/MCP de archivos.

Extraer una capa común de transporte y ciclo de vida. Crear `AgentSession`
como sesión bidireccional, sin el cierre automático de diez segundos tras un
envío. Serializar envíos de archivos por dirección para respetar la recepción
actual, y priorizar recibos pequeños frente a chunks grandes. Los adjuntos
reutilizan streaming de 128 KiB, límites y confirmación de escritura.

Guardar inbox/outbox de agentes localmente, con escritura atómica, permisos
privados, cuota y TTL. Esta persistencia es necesaria para confirmar entrega
sin perder el mensaje si el MCP reinicia; no cambia las sesiones de archivos
existentes ni añade almacenamiento al servidor. Propuesta inicial: texto/JSON
de hasta 64 KiB por mensaje, 1.000 mensajes y 64 MiB de contenido textual por
conversación, retención de 24 horas; adjuntos con su propia cuota de disco.
Rechazar explícitamente si no hay espacio; no descartar mensajes sin leer para
aceptar otros. Confirmar `delivered` después de completar la escritura.

Usar IDs estables y deduplicación: entrega al menos una vez con lectura lógica
única. Si se pierde un recibo, reenviar el mismo ID y recuperar su estado.
Tras reconectar, negociar qué mensajes completos faltan. Los archivos
interrumpidos se reinician completos en la primera versión; la reanudación
por bloques sigue fuera de alcance.

## Emparejamiento y límites de confianza

El código de cuatro caracteres localiza la sala, pero no autentica a otro
agente. La invitación debe incluir un secreto aleatorio de alta entropía,
compartido inicialmente por el usuario o un canal ya confiable. No publicarlo
en métricas, logs ni URLs del servidor. Para otro proyecto en la misma máquina,
el usuario también intercambia la invitación entre sus dos conversaciones.

Antes de intercambiar contenido, se establece autenticación mutua y cifrado de
extremo a extremo mediante TLS 1.3 PSK de Node/OpenSSL, sobre un stream local
adaptado al transporte de fAir Drop. No se añade un cifrado ni handshake propio.
La invitación incluye una clave aleatoria de 256 bits; se rechazan mensajes
previos a autenticación y se vincula la identidad del peer a la conversación.
Así el relay no puede leer mensajes de agentes ni sus adjuntos.

Vincular cada sesión al proceso y al proyecto declarado, sin publicar el path
completo del repositorio por defecto. Un mensaje remoto es información del
peer: no obtiene permiso para ejecutar comandos, cambiar archivos, publicar,
ni incorporar instrucciones a las reglas del agente. Esas acciones siguen
las instrucciones y permisos de la conversación receptora.

Definir plazo de espera de peer, timeout de entrega, duración máxima y cierre
explícito. Las sesiones no son buzones públicos permanentes: si el MCP receptor
no está conectado, el emisor conserva localmente lo pendiente hasta el plazo;
el VPS no permite recoger mensajes offline.

## Ejemplo: agente en VPS y agente local

1. El agente del VPS llama a `create` y muestra la invitación al usuario.
2. El usuario la pasa al agente local; este llama a `join`.
3. Ambos MCP autentican al peer y negocian la conexión.
4. El agente local llama a `send`: «revisa este error», con un log adjunto.
5. El MCP del VPS lo guarda y confirma `delivered` automáticamente.
6. El agente del VPS obtiene el mensaje mediante `wait_message` o `inbox`,
   inspecciona el contenido y llama a `ack`.
7. Trabaja dentro de su autorización local y llama a `send` con `reply_to`.
8. El agente local recibe el resultado, confirma lectura y ambos cierran.

El mismo flujo sirve entre dos proyectos locales y entre arneses diferentes.
No requiere exponer un servidor MCP remoto ni crear credenciales de un modelo.

## Notificación y activación automática

La primera versión asegura descubrimiento mediante herramientas: `inbox` y
`wait_message`. Una notificación MCP puede anunciar novedades si el cliente
la soporta, pero no es un mecanismo universal para iniciar un turno del modelo.
Tampoco usar `notifications/tools/list_changed`: anuncia cambios de herramientas,
no mensajes de una sala.

En una segunda fase, crear adaptadores opcionales para clientes con APIs/hooks
documentados que permitan avisar o iniciar un turno. Un arnés sin esa capacidad
mantiene el flujo manual/espera. Si se necesita servicio continuo o varias
conversaciones compartiendo una bandeja, añadir un daemon local con adaptadores
stdio, identidad por proyecto y control de acceso; no es requisito del MVP.

## Fases y criterio de aceptación

1. **Contrato y transporte:** esquemas, herramientas, identidad de sesión,
   emparejamiento cifrado y capa de transporte reutilizable. Dos procesos MCP
   intercambian mensajes JSON/texto en ambas direcciones.
2. **Bandeja y recibos:** inbox/outbox local, cursores, espera cancelable,
   deduplicación y estados de entrega/lectura/respuesta. Reiniciar tras guardar
   un mensaje no lo pierde; perder un recibo no duplica la lectura.
3. **Adjuntos:** streaming, cuota, recepción segura y serialización por
   dirección. Un mensaje con adjuntos solo se entrega completo; rechazos de
   disco y desconexiones producen errores visibles.
4. **Compatibilidad:** configurar y probar Codex, OpenCode, Claude Code, VS Code
   y Cursor. Publicar ejemplos por arnés, tiempos de espera y matriz de soporte
   probado. Verificar descubrimiento de tools y un intercambio real entre dos
   clientes distintos, además de VPS ↔ máquina local.
5. **Activación opcional:** investigar soporte por arnés y construir solamente
   adaptadores documentados; mantener las herramientas como base común.

Pruebas obligatorias: P2P y relay, peer sin capacidades, secreto incorrecto,
mensajes malformados, IDs duplicados, respuesta correlacionada, timeout vacío,
cancelación sin consumo, cierre durante espera/envío, reconexión, reinicio,
cuota llena, separación de proyectos y limpieza sin pérdida de mensajes.

## Fuentes

- [MCP: descubrimiento y esquemas de herramientas](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
- [Configuración MCP en Codex e instrucciones de servidor](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

El diseño de mensajería es una propuesta propia sobre el protocolo de fAir Drop;
MCP proporciona la interfaz entre el agente y su proceso local.

## Emparejamiento corto implementado en 1.3.0

Crear devuelve `pairing_code` de ocho caracteres: localizador de sala de cuatro
y PIN aleatorio de cuatro. SRP-6a de Homebridge autentica el PIN sin enviarlo y
HKDF deriva la clave TLS de 256 bits. Caduca en diez minutos, cinco intentos
persistidos, un único emparejamiento. Después se conserva la misma sala para
todos los mensajes; `resume` usa la clave fuerte guardada localmente.
Se conserva la opción de invitación larga para clientes 1.2.
