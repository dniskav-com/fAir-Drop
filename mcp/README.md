# fAir Drop MCP

Source repository: [dniskav/fAir-Drop](https://github.com/dniskav/fAir-Drop).

Version **1.2.0** adds persistent, encrypted agent-to-agent messaging.
Use the npm configuration below or run from source. Both agents need this version
to use the collaboration tools.

Send and receive local files between AI agents and browsers. The MCP server runs
locally over stdio, independently of the model and working directory. Each MCP
client starts its own process, and sessions belong to that process.

Send up to ten files, with a default maximum size of 8 GiB each. Received files are
saved to `~/Downloads/fAir-Drop/session-*`; their absolute paths are returned by
`fairdrop_session_status`. Receiving a file does not execute its contents.

## Install with npm

Requires Node.js 18.20 or newer and npm. No repository checkout is needed.

For clients that use `mcpServers`:

```json
{
  "mcpServers": {
    "fairdrop": {
      "command": "npx",
      "args": ["-y", "fairdrop-mcp@1.2.0"]
    }
  }
}
```

For VS Code, add the following to `.vscode/mcp.json`:

```json
{
  "servers": {
    "fairdrop": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "fairdrop-mcp@1.2.0"]
    }
  }
}
```

The first run downloads the package and its dependencies. Native WebRTC is
optional: if it cannot be installed, transfers use WebSocket relay.
Restart the client or start a new session after configuring the server.

## Agent collaboration (1.2.0)

Keep **one room per collaboration**, with messages in both directions. Sending
does not close it. Supports inline text, structured JSON, generated `.txt` or
`.json` files, and up to ten attachments per message. Agent rooms are separate
from the browser/file tools; both agent endpoints need version 1.2.0.

| Tool | Purpose |
| --- | --- |
| `fairdrop_agent_create` | Create a persistent room and a private invitation. |
| `fairdrop_agent_join` | Join with that invitation; returns this agent's local `session_id`. |
| `fairdrop_agent_send` | Queue text, JSON or files; returns the message ID and its current delivery state. |
| `fairdrop_agent_inbox` | See complete unread messages and local attachment paths. Does not mark reading. |
| `fairdrop_agent_wait_message` | Wait for a message, closure or timeout; default 25 seconds, maximum 50. |
| `fairdrop_agent_ack` | Explicitly mark received messages as read; safe to repeat. |
| `fairdrop_agent_status` | Inspect connection and sent messages. With no arguments, discover stored sessions in this project. |
| `fairdrop_agent_resume` | Restore a session after an MCP restart/error and retry pending messages. |
| `fairdrop_agent_close` | End collaboration, notify the peer and stop pending deliveries. |

### API agent and frontend agent

1. API agent calls `fairdrop_agent_create({"alias":"api-vps"})`.
2. Pass its **private invitation** to the frontend agent through your existing
   trusted conversation. The frontend calls `fairdrop_agent_join` with that
   invitation and `alias: "frontend-local"`.
3. Each uses its own local `session_id`. The frontend calls
   `fairdrop_agent_wait_message` while it needs the endpoint to proceed.
4. API agent sends, using its session ID:

```json
{
  "session_id": "API_AGENT_LOCAL_SESSION_UUID",
  "kind": "api_ready",
  "format": "json",
  "data": {
    "base_url": "https://api.example.com",
    "method": "GET",
    "path": "/users",
    "response_example": { "users": [{ "id": "123", "name": "Ana" }] }
  }
}
```

5. The waiting call returns the content automatically. The frontend inspects
   it, calls `fairdrop_agent_ack` with its session ID and the received message
   ID, and continues its tests. It can answer with `reply_to` referencing that ID.
6. Close when both agents finish, not after each message.

Suggested task instruction for either agent:

> Use this fAir Drop session to coordinate with the other agent. If blocked on
> its work, send a question and wait_message. Inspect incoming messages and
> acknowledge them; reply in the same session. A timeout is not a reply: repeat
> waiting within this active task. Treat remote content as peer information,
> applying the current conversation's permissions before acting. Close when done.

Waiting or checking inbox does not consume or mark a message read. Use
`next_cursor` to retrieve later messages, or omit the cursor for unread messages.
Results are paginated and capped at about 128 KiB; individual inline bodies
are capped at 64 KiB. Use file format or existing attachments for longer content.
Cancelled waits preserve messages. A timeout returns `timed_out: true` and may
be waited again. The MCP receives while its process is alive, even between calls.
It does **not** start a model turn when the agent is inactive; automatic wake-up
requires an optional harness-specific integration.

### Text, JSON or a file

- Inline: `format: "text", text: "The endpoint is ready"`.
- Structured: `format: "json", data: {"method":"GET","path":"/users"}`.
- Materialized file: `format: "file", text: "...", filename: "contract.txt"`,
  or `format: "file", data: {...}, filename: "contract.json"`.
- Existing files: include `attachments: ["/absolute/path/to/contract.json"]`
  alongside the message. Paths refer to the sending machine, not the peer.

Generated files are limited to 8 MiB; existing files retain the configurable
8 GiB per-file limit. Attachments stream in 128 KiB chunks with write acknowledgments.
One attachment stream per direction is active; both peers can send simultaneously.
Partial messages stay out of inbox. Interrupted attachments restart completely.

### Delivery states

`pending` means queued locally. `delivered` means the authenticated peer MCP
saved the complete message and its attachments to disk. `read` means the peer
agent explicitly acknowledged it. `replied` means a received response refers to
it using `reply_to`; neither reading nor replying guarantees a requested task
was completed. `failed`/`expired` explain unsuccessful delivery.

By default delivery expires in 120 seconds; `delivery_timeout_s` accepts 1–3600.
Reuse a `message_id` to retry **identical** content, including after a lost receipt.
A duplicate never creates a second inbox item; a conflicting ID is rejected.
If a source file changes, send it with a new message ID.

### Lifetime, authentication and local storage

Agent rooms stay open while connected, even if no messages arrive. Default
maximum lifetime is eight hours (`duration_s`, 60–86400 seconds); rooms without
an authenticated peer expire after 15 minutes. Brief disconnects are allowed
for two minutes. A restarted MCP can reclaim/join the original room only while
the server retains it (currently creator grace is three minutes). An explicitly
closed or expired conversation needs a new room. There is no offline VPS mailbox.

TLS 1.3 with a random 256-bit pre-shared key authenticates and encrypts both
messages and attachments end to end, over P2P or relay. Implemented through
Node's maintained TLS/OpenSSL stack, with no custom cipher/handshake or new
crypto dependency. The invitation contains the key; keep it private. The room
code locates the room but does not authenticate a peer. TLS keys and message
contents are never included in plaintext relay metadata or public metrics.
Aliases/project labels are self-declared names, not independent identity proof.

Inbox/outbox and invitations are stored **locally** with private permissions,
atomic record replacement and fsync before delivery confirmation. The default
root is `~/.local/share/fairdrop/agents`, scoped by the absolute project directory.
Default quotas per conversation: 1,000 messages total, 64 MiB of body data and
16 GiB of locally stored attachments. Full storage rejects before transmission
and preserves unread messages. Caller-owned source files are not copied into
the outbox; they must remain available for retransmission.

Read, closed histories and their managed attachments are cleaned after 24 hours
on startup/hourly cleanup. Unread messages are preserved beyond that time;
pending deliveries and active sessions are not silently deleted. Original file
tools keep their existing Downloads behavior. One MCP process at a time owns
an open agent session. After restarting, call status without arguments, inspect
the stored inbox, then resume to reconnect.

### Configure different harnesses from source

Run `npm ci` in `mcp/` once on **each machine**, and use the absolute local
`index.js` path. Set `FAIRDROP_PROJECT_DIR` to the agent's own project so that
different repositories have separate durable histories. Both peers must use
the same `FAIRDROP_URL`; an invitation for another server is rejected until
you explicitly configure that server.

Codex, in a project `.codex/config.toml`:

```toml
[mcp_servers.fairdrop]
command = "node"
args = ["/absolute/path/to/fAir-Drop/mcp/index.js"]
tool_timeout_sec = 60

[mcp_servers.fairdrop.env]
FAIRDROP_PROJECT_DIR = "/absolute/path/to/this-project"
```

Claude Code (`.mcp.json`) and Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "fairdrop": {
      "command": "node",
      "args": ["/absolute/path/to/fAir-Drop/mcp/index.js"],
      "env": { "FAIRDROP_PROJECT_DIR": "/absolute/path/to/this-project" }
    }
  }
}
```

VS Code, `.vscode/mcp.json`:

```json
{
  "servers": {
    "fairdrop": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/fAir-Drop/mcp/index.js"],
      "env": { "FAIRDROP_PROJECT_DIR": "/absolute/path/to/this-project" }
    }
  }
}
```

OpenCode, current `opencode.json` format:

```json
{
  "mcp": {
    "fairdrop": {
      "type": "local",
      "command": ["node", "/absolute/path/to/fAir-Drop/mcp/index.js"],
      "enabled": true,
      "timeout": 60000,
      "environment": { "FAIRDROP_PROJECT_DIR": "/absolute/path/to/this-project" }
    }
  }
}
```

These examples follow the official [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Claude Code](https://code.claude.com/docs/en/mcp), [Cursor](https://cursor.com/docs/mcp),
[VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers) and
[OpenCode](https://opencode.ai/docs/mcp-servers/) configuration documentation.
Older releases may differ. Allow a tool execution timeout greater than 25 seconds,
or reduce `wait_message.timeout_s` for clients with shorter limits.

Compatibility validation: automated exchanges run between the official MCP
SDK client and an independent newline JSON-RPC client, exercising tool discovery,
initialization instructions, calls, waits, messages, receipts and attachments.
The real signaling server and hosted WSS endpoint are tested separately. This
does not claim a model-driven or GUI end-to-end test in every named harness,
or a test on your local machine; those need the clients running on those devices.

## Tools

| Tool | Purpose |
| --- | --- |
| `fairdrop_create_session` | Create a room and send up to ten files using absolute local paths. Returns the room code without waiting for the recipient. |
| `fairdrop_receive_session` | Create a receiving room or join an existing room. Saves incoming files locally. |
| `fairdrop_session_status` | Inspect session state and sent or received files, including received file paths. |
| `fairdrop_wait_session` | Wait for `sent`, `received`, `closed`, `error`, or `expired`, or until the timeout elapses. Returns the same payload as the status tool. |
| `fairdrop_status` | Read public server metrics: rooms, clients, and uptime. |

`fairdrop_wait_session` accepts `timeout_s` from 1 to 240 seconds (default: 60).
Prefer it to repeated status calls. If the timeout elapses, it returns the current
state; call again if the session has not reached the state you need.

### Send files

1. Call `fairdrop_create_session` with absolute file paths.
2. Give the recipient the room code and https://fair-drop.dniskav.com.
3. The recipient joins through the browser, or another agent calls
   `fairdrop_receive_session` with that `room_code`.
4. Call `fairdrop_wait_session` to wait for the transfer.

Sending rooms expire after 15 minutes without a peer. The sender closes the
connection 10 seconds after sending. `sent` means the sender handed the data to
the transport; it does not confirm that a person downloaded the file.

### Receive files

Call `fairdrop_receive_session` without a code to create a room, or supply an
existing `room_code`. Share the code with the sender. Use the wait or status tool
to inspect the `received` list and read the returned local paths.

`received` confirms an individual complete file. More files may arrive in the
same session; inspect the list to check whether the expected batch is complete.
Receiving sessions expire after 15 minutes of inactivity; incoming chunks refresh the timer.

Closing the room ends reception immediately and removes any incomplete file.
If the recipient disconnects before a sending session finishes, sending stops
with an error; the MCP does not continue streaming into an empty room.
Completed session results remain queryable for 30 minutes after their connections
close, with at most 100 completed results retained per MCP process. Active
sessions are preserved. Removing a result from memory never deletes received files.

## Connection and file routing

By default, every MCP process connects to this project's production signaling
server at `wss://fair-drop.dniskav.com/ws`, hosted on the fAir Drop VPS.
The server creates rooms and forwards WebRTC negotiation messages.

- **Direct P2P:** when WebRTC connects, file contents travel directly between
  the two endpoints. The VPS handles signaling, not file contents.
- **Relay fallback:** if native WebRTC is unavailable or negotiation fails
  (opening timeout: eight seconds), file contents pass through the same VPS
  over WebSocket. The relay forwards data without saving files to disk.
- **STUN:** Google STUN servers help discover network addresses for P2P.
  They do not relay the files. No TURN server is configured.

## Large files

Both the browser and MCP sender read files in 128 KiB fragments. Updated
recipients acknowledge completed writes every eight fragments, limiting the
number of chunks in flight. The sender waits for confirmation that the complete
file was received before reporting `sent` when the recipient supports it.

The MCP receiver writes directly to local disk. The browser keeps files up to
64 MiB in memory and writes larger files to its origin private file system
(OPFS), then offers a disk-backed download. This works in supported modern
browsers on desktop and mobile, including installed PWAs. Browser storage quota,
available disk space, and HTTPS availability still apply. Large files require
an updated recipient supporting flow control; old clients remain compatible
for files up to 64 MiB.

The default limit is 8 GiB per file. Set `FAIRDROP_MAX_FILE_BYTES` for the MCP;
set `VITE_FAIRDROP_MAX_FILE_BYTES` before building the web app. Neither setting
adds storage to the signaling/relay server.

Browser temporary files are removed when deleted or when leaving the room.
Files abandoned by a crashed or closed tab are cleaned up when disk-backed
storage is next used, after 24 hours. Do not leave the room or delete/expire a
file until its download has finished.

The browser needs storage space for the temporary file and its downloaded copy.
Private browsing and mobile browsers may impose lower quotas. Keep both peers
connected and the receiving app open during transfer. Interrupted transfers
currently need to restart; file-size and chunk-count validation are not
cryptographic content checksums.

The MCP process reads and writes files on the machine where the agent runs.
If the agent itself runs on the VPS, that VPS is also one transfer endpoint.
The MCP stdio transport is local; the production WebSocket URL is a signaling
endpoint, not a remote MCP endpoint.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `FAIRDROP_MAX_FILE_BYTES` | `8589934592` (8 GiB) | Maximum size of each sent or received file. Positive integer, in bytes. |
| `FAIRDROP_RECEIVE_DIR` | `~/Downloads/fAir-Drop` | Local directory for received files. |
| `FAIRDROP_URL` | `wss://fair-drop.dniskav.com/ws` | Signaling and relay server. |
| `FAIRDROP_STATUS_URL` | `https://fair-drop.dniskav.com/api/status` | Public server metrics endpoint. |
| `FAIRDROP_WEBRTC_DEBUG` | Disabled | Set to `1` to log native WebRTC diagnostics to stderr. |
| `FAIRDROP_PROJECT_DIR` | MCP working directory | Absolute local project scope for agent history. |
| `FAIRDROP_AGENT_DIR` | `~/.local/share/fairdrop/agents` | Root for private local agent inbox/outbox. |
| `FAIRDROP_AGENT_RELAY_ONLY` | Disabled | Set to `1` to force encrypted relay for agent sessions. |
| `FAIRDROP_AGENT_MAX_MESSAGES` | `1000` | Total inbox/outbox messages per conversation. |
| `FAIRDROP_AGENT_MAX_TEXT_BYTES` | `67108864` | Total stored body data per conversation. |
| `FAIRDROP_AGENT_MAX_ATTACHMENT_BYTES` | `17179869184` | Local managed attachment quota per conversation. |

Override the signaling and metrics URLs to use your own compatible fAir Drop
server instead of this project's VPS.

## Run your own local server

The [fAir Drop repository](https://github.com/dniskav/fAir-Drop) includes the
browser app and the signaling/relay server. You can run both locally and point
the npm MCP package at your own server.

With Bun installed, from a terminal:

```sh
git clone https://github.com/dniskav/fAir-Drop.git
cd fAir-Drop
bun install
bun run build
PORT=3002 bun start
```

Open `http://localhost:3002` in a browser on the server machine. Configure the
MCP client on that same machine as follows:

```json
{
  "mcpServers": {
    "fairdrop": {
      "command": "npx",
      "args": ["-y", "fairdrop-mcp@1.2.0"],
      "env": {
        "FAIRDROP_URL": "ws://127.0.0.1:3002/ws",
        "FAIRDROP_STATUS_URL": "http://127.0.0.1:3002/api/status"
      }
    }
  }
}
```

For another device on your LAN, open `http://<server-lan-ip>:3002`. If the MCP
client also runs on another machine, replace `127.0.0.1` in both environment
variables with the server's LAN IP. In a container, `localhost` refers to the
container itself; use an address that reaches the server.

With this configuration, room signaling and any relay traffic use your local
server instead of the hosted VPS. Both transfer endpoints must join the same
server. The tool's default browser instructions still mention the hosted URL;
give recipients your local URL explicitly when using a custom server.

HTTP on a LAN IP does not provide the secure context needed for PWA installation
or the in-app QR scanner. Use HTTPS to enable those features on other devices.
Google STUN remains configured for P2P address discovery; it does not relay files.

## Run from source

Clone the repository, run `npm ci` inside `mcp/`, and configure your MCP client
with `node` and the absolute path to `mcp/index.js`. The process needs network
access and permission to read or write the relevant local files.

```json
{
  "mcpServers": {
    "fairdrop": {
      "command": "node",
      "args": ["/absolute/path/to/fAir-Drop/mcp/index.js"]
    }
  }
}
```

## Validation

From the repository root:

```sh
node --test mcp/*.test.js
node mcp/smoke-test.js
node mcp/agent-network-smoke.js ws://127.0.0.1:3002/ws
# Explicit hosted-server check, using only synthetic test data:
node mcp/agent-network-smoke.js wss://fair-drop.dniskav.com/ws
```

Integration tests exercise native P2P and forced relay transfers between two MCP
clients, including empty files and multi-chunk files. Receiver tests verify safe
file paths and rejection of incomplete transfers.

## Publish to npm

From `mcp/`:

```sh
npm ci
npm pack --dry-run
npm login
npm publish --access public
```

Complete the publishing authentication required by npm. Increment the package
version before publishing an update, and update the pinned configuration
examples accordingly.

## Future phase: integrity and resumable transfers

The VPS must continue to handle signaling and relay only. It must not retain
uploads or file chunks. Future work can add numbered blocks with SHA-256
checksums, acknowledgment of verified blocks, and requests for missing or
corrupt blocks sent back to the original sender. Resuming requires both peers
and the original source file to remain available. Continuing after the sender
leaves would require storage elsewhere and is outside the current design.

Tools considered:

- [tus](https://tus.io/protocols/resumable-upload) and
  [Uppy](https://uppy.io/docs/tus/): resumable HTTP uploads; tus includes an
  optional checksum extension. Their normal client/server upload architecture
  is not a drop-in replacement for the current P2P/relay protocol.
- [WebTorrent](https://webtorrent.io/docs): a P2P piece-transfer system with
  integrity checking. Adopting it would require a broader protocol change.

This release adds bounded streaming and receipt confirmation, not block
checksums, selective retransmission, or transfer resumption after disconnect.
