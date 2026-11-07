# Craft Apps for VS Code

Open the [storytold craft apps](https://github.com/storytold) (PhotoCraft, VectorCraft, LightCraft,
FilmCraft, EffectCraft) in VS Code editor panels, and let a coding agent drive them over MCP. The
agent can be Claude Code, Codex, Gemini CLI or the chat that is built into VS Code. With
code-server you can do all of it in one browser tab, on an iPad too: the app runs in a panel, and
Claude works in it from the panel next to it while you watch.

The apps come from a [craft-ai-hub](https://github.com/hayone1/craft-ai-hub), so they keep the
hub's sign-in, cloud storage and AI chat (the round ✦ button). This extension adds:

- **A Craft view** in the activity bar that lists the apps. Click one to open it in an editor
  panel. Panels keep running when you switch tabs, and come back after a reload.
- **One MCP server for every open app**, at `http://127.0.0.1:47811/mcp`. Each connected app's
  tools show up as `<app>_<tool>` (`vectorcraft_draw_shape`, `photocraft_doc_new`, …). Three
  tools are always there:
  - `craft_apps` lists the apps, and says which are open and connected.
  - `craft_open` opens an app in the editor and waits until it is connected, so the agent can
    open what it needs.
  - `craft_call` calls any tool of an open app, for clients that miss tool-list updates.
- **Agent setup**: the extension adds the server, with its token, to the user settings of every
  coding agent it finds. Start a new agent session, and say what you want: "open VectorCraft and
  draw a gold star". The next section lists the agents.
- **A token on every request**: the MCP server only answers requests that carry its token. The
  section "The MCP token" explains where the token comes from.

## Coding agents

The extension writes the `craft` MCP server (the URL and the token) into each agent's own user
settings. An agent counts as installed when its command is on `PATH` or its settings folder
exists.

| Agent | Where the extension writes the server |
| --- | --- |
| Claude Code | `~/.claude.json`, through `claude mcp add --scope user`. The extension also uses the `claude` program inside the Claude Code extension, so a `claude` command on `PATH` is not needed. |
| Codex | The `[mcp_servers.craft]` table in `~/.codex/config.toml` (or `$CODEX_HOME`). The Codex command and the Codex VS Code extension both read that file. |
| Gemini CLI | `mcpServers.craft` in `~/.gemini/settings.json`. |
| VS Code chat | No file: the extension offers the server to VS Code directly (an MCP server definition provider), where the editor supports one. |

An agent that you install later still gets the server. The extension checks again every 5
minutes, after each command that ends in a terminal, and when you run **Craft: Add the MCP Server
to Coding Agents**. The extension only writes when an entry is missing or out of date, so an
entry that is already right stays untouched. The `craft.agents` setting picks the agents. Remove
an agent from the list, and the extension leaves that agent's settings alone.

A Gemini `settings.json` that contains comments is not plain JSON. The extension doesn't rewrite
such a file, because the rewrite would drop the comments. Add the server to that file by hand.

## The MCP token

The MCP server listens on `127.0.0.1`, so only programs on the same machine can reach the
server. Every program on the machine can, though, so each request must carry the header
`Authorization: Bearer <token>`. Without the token, a request gets the answer `401`.

- If the environment variable `CRAFT_MCP_TOKEN` is set, the extension uses that value. Set the
  variable when you want to choose the token yourself, for example in a Coder template.
- Otherwise the extension makes a random token on first start and saves the token in
  `~/.craft-vscode/mcp-token`. Only your user can read that file. Every editor window on the
  machine uses the same file, so all windows agree on one token.

The extension also puts `CRAFT_MCP_URL` and `CRAFT_MCP_TOKEN` into the environment of new VS Code
terminals. A script or an agent that starts in such a terminal can use the two variables. A
project can then check in a `.mcp.json` that holds no secret:

```json
{
  "mcpServers": {
    "craft": {
      "type": "http",
      "url": "${CRAFT_MCP_URL:-http://127.0.0.1:47811/mcp}",
      "headers": { "Authorization": "Bearer ${CRAFT_MCP_TOKEN}" }
    }
  }
}
```

You don't need that file for the agents in the table above, because the extension already sets
them up. **Craft: Copy MCP Server Token** copies the token. **Craft: Make a New MCP Server Token**
replaces the saved token and gives the new token to the agents. Agent sessions that are running
at that moment keep the old token, so restart those sessions.

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

A hub without `EMBED_ORIGINS` still works: open the app's AI chat (the round ✦ button) › **Connect** tab, copy the
URL, and run **Craft: Set an App's MCP URL by Hand**.

## Install

Install **Craft Apps** (`hayone1.craft-vscode`) from the Visual Studio Marketplace in VS Code, or
from [Open VSX](https://open-vsx.org) in code-server, VSCodium and other editors that use Open
VSX:

```sh
code --install-extension hayone1.craft-vscode          # VS Code
code-server --install-extension hayone1.craft-vscode   # code-server (Open VSX)
```

Each [release](https://github.com/hayone1/craft-vscode/releases/latest) also has the `.vsix`
file, for machines that can't reach either store: `code --install-extension craft-vscode-<version>.vsix`.

Set the hub's address in the `craft.hubUrl` setting, or in the `CRAFT_HUB_URL` environment
variable of the workspace.

### Coder

In a template that uses Coder's `code-server` module, add the extension to the module's
`extensions` list. The module installs extensions from Open VSX. Then set the hub for the
workspace on the agent:

```hcl
module "code-server" {
  source     = "registry.coder.com/coder/code-server/coder"
  agent_id   = coder_agent.main.id
  extensions = ["anthropic.claude-code", "hayone1.craft-vscode"]
}

resource "coder_agent" "main" {
  env = {
    CRAFT_HUB_URL = "https://craft.example.com"
  }
}
```

The template doesn't need to run `claude mcp add`, because the extension sets up the agents
itself. To choose the MCP token yourself, also set `CRAFT_MCP_TOKEN` in the agent's `env`.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `craft.hubUrl` | `CRAFT_HUB_URL` | The hub, e.g. `https://craft.example.com`. |
| `craft.apps` | `CRAFT_APPS`, else the five apps | The apps, in order. |
| `craft.mcpPort` | `47811` | The local MCP server's port. |
| `craft.agents` | `["claude", "codex", "gemini"]` | The coding agents that get the server. |

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

`src/agents.mjs` writes the server into the agents' settings, and `src/token.mjs` finds or makes
the token. Both run in plain Node too, and the tests use a temporary home folder.

## Release

A tag `v<version>` that matches `version` in `package.json` makes the CI build the `.vsix`,
create a GitHub release, and publish the same `.vsix` to both stores. The CI skips a store whose
token secret is missing, so a release without the secrets still lands on GitHub.

| Secret | Store | How to get the token |
| --- | --- | --- |
| `VSCE_PAT` | Visual Studio Marketplace | Create the publisher `hayone1` at https://marketplace.visualstudio.com/manage. Then create an Azure DevOps personal access token with the scope **Marketplace › Manage** and the organization **All accessible organizations**. |
| `OVSX_PAT` | Open VSX | Sign in at https://open-vsx.org with GitHub, link an Eclipse account and sign the publisher agreement, then create an access token in the settings. Before the first release, run `npx ovsx create-namespace hayone1 -p <token>` once. |

Save both tokens under **Settings › Secrets and variables › Actions** in this repository.

`src/bridge.mjs` is the MCP server and its clients (plain Node, tested on its own).
`src/extension.mjs` is the VS Code side: the panels, the Craft view and the window handover.

## License

MIT
