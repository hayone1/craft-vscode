# Craft Apps for VS Code

Open the [storytold craft apps](https://github.com/storytold) (PhotoCraft, VectorCraft, LightCraft,
FilmCraft, EffectCraft) in VS Code editor panels, and let Claude Code drive them over MCP. With
code-server you can do all of it in one browser tab, on an iPad too: the app runs in a panel, and
Claude works in it from the panel next to it while you watch.

The apps come from a [craft-ai-hub](https://github.com/hayone1/craft-ai-hub), so they keep the
hub's sign-in, cloud storage and **Ask AI** chat. This extension adds:

- **A Craft view** in the activity bar that lists the apps. Click one to open it in an editor
  panel. Panels keep running when you switch tabs, and come back after a reload.
- **One MCP server for every open app**, at `http://127.0.0.1:47811/mcp`. Each connected app's
  tools show up as `<app>_<tool>` (`vectorcraft_draw_shape`, `photocraft_doc_new`, …). Three
  tools are always there:
  - `craft_apps` lists the apps, and says which are open and connected.
  - `craft_open` opens an app in the editor and waits until it is connected, so the agent can
    open what it needs.
  - `craft_call` calls any tool of an open app, for clients that miss tool-list updates.
- **Claude Code setup**: on start, the extension adds the server to Claude Code
  (`claude mcp add --scope user craft …`) if it isn't there yet. Start a new Claude
  conversation, and say what you want: "open VectorCraft and draw a gold star".
- VS Code's own chat gets the same server (an MCP server definition provider), where the
  editor supports one.

```
browser tab (code-server)
├─ Claude Code panel ── MCP ──▶ craft-vscode (127.0.0.1:47811, in the workspace)
│                                  │ MCP, one client per open app
└─ VectorCraft panel               ▼
   └─ hub page (iframe) ◀── WebSocket ── craft-mcp relay ◀── <app> CLI bridge
```

## How a panel gets connected

The panel shows the hub page `https://<hub>/<app>/` in an iframe. The extension's page asks the
hub's overlay for the tab's MCP URL (a `craft-embed:hello` message). The overlay answers its
direct parent only, and only if the parent's origin is in the hub's `EMBED_ORIGINS`. It also
connects the tab to the relay first, if it isn't connected yet. The extension then keeps an MCP
client to that URL. Nothing is copied by hand.

On the hub, set `EMBED_ORIGINS` to the origin your editor serves webviews from. For code-server
behind Coder, that is the workspace app's origin:

```
EMBED_ORIGINS=https://*.code.example.com
```

A hub without `EMBED_ORIGINS` still works: open the app's **Ask AI** › **Connect** tab, copy the
URL, and run **Craft: Set an App's MCP URL by Hand**.

## Install

The extension isn't on a marketplace yet. Download the `.vsix` from the
[latest release](https://github.com/hayone1/craft-vscode/releases/latest), then:

```sh
code-server --install-extension craft-vscode-<version>.vsix   # or: code --install-extension …
```

Set the hub's address in the `craft.hubUrl` setting, or in the `CRAFT_HUB_URL` environment
variable of the workspace.

### Coder

In a template that uses the `code-server` module, install it from the release in the agent's
startup script and set the hub for the workspace:

```hcl
resource "coder_agent" "main" {
  env = {
    CRAFT_HUB_URL = "https://craft.example.com"
  }
  startup_script = <<-EOT
    v=0.1.0
    curl -fsSL -o /tmp/craft-vscode.vsix \
      https://github.com/hayone1/craft-vscode/releases/download/v$v/craft-vscode-$v.vsix
    # code-server may still be installing; the module puts it in /tmp/code-server.
    for i in $(seq 60); do [ -x /tmp/code-server/bin/code-server ] && break; sleep 2; done
    /tmp/code-server/bin/code-server --install-extension /tmp/craft-vscode.vsix --force || true
  EOT
}
```

## Settings

| Setting | Default | |
| --- | --- | --- |
| `craft.hubUrl` | `CRAFT_HUB_URL` | The hub, e.g. `https://craft.example.com`. |
| `craft.apps` | `CRAFT_APPS`, else the five apps | The apps, in order. |
| `craft.mcpPort` | `47811` | The local MCP server's port. |
| `craft.registerWithClaudeCode` | `true` | Add the server to Claude Code on start. |

## Notes

- **Signing in.** The panel uses the hub's own sign-in. If the hub's sign-in page can't show in
  a frame, press **Sign in** in the panel's note, sign in in the browser tab that opens, then
  **Reload**. The hub and the editor must be on the same site (for example
  `craft.example.com` and `*.code.example.com`), or Safari won't send the hub's cookie to the
  panel.
- **code-server, not "VS Code Web".** code-server serves webviews from the workspace's own
  origin, so the hub's cookie and the handshake work. Microsoft's VS Code server (`code
  serve-web`) serves them from `vscode-cdn.net`, another site, where Safari blocks the hub's
  cookie.
- **More than one window.** The first window serves the port. The others report their panels to
  it and take over if it stops. An agent's `craft_open` goes to the window that has the app,
  else to the one focused last. This matters in code-server, which keeps a closed tab's
  extension host running for hours.
- **Keep the panel open while an agent works.** The app runs in your browser tab. If the tab
  sleeps (an iPad does this to background tabs), calls wait until it is back.

## Develop

```sh
npm ci
npm test          # the MCP bridge against a stand-in relay
npm run package   # dist/extension.js and craft-vscode-<version>.vsix
```

`src/bridge.mjs` is the MCP server and its clients (plain Node, tested on its own).
`src/extension.mjs` is the VS Code side: the panels, the Craft view and the window handover.

## License

MIT
