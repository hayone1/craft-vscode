# Craft Apps for VS Code

Open the [storytold craft apps](https://github.com/storytold) (PhotoCraft, VectorCraft, LightCraft,
FilmCraft, EffectCraft) in VS Code editor panels, and let a coding agent drive them over MCP. The
agent can be Claude Code, Codex, Gemini CLI or the chat that is built into VS Code. With
code-server you can do all of it in one browser tab, on an iPad too: the app runs in a panel, and
Claude works in it from the panel next to it while you watch.

Each panel shows the app's own web page. The pages come from the `hayone/<app>:remote` images
that [hayone1/Docker_Images](https://github.com/hayone1/Docker_Images) builds, and the coding
agent reaches them through the [craft-mcp](https://hub.docker.com/r/hayone/craft-mcp) relay. The
section [What the apps need](#what-the-apps-need) lists the setup. This extension adds:

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
   └─ app page (iframe) ◀── WebSocket ── craft-mcp relay ◀── <app> CLI bridge
```

## What the apps need

The extension needs three things: the app pages, the relay, and a relay token. You don't need
craft-web-gateway. The gateway is a separate product for people who open the apps in a browser
tab, with its own launcher, chat and cloud storage, and the extension doesn't use it.

1. **Run the app images.** Run `hayone/<app>:remote` for each app, for example
   `hayone/photocraft:remote`. Each image serves its app on port 8080. The extension needs an
   address for each app that the machine running the extension can reach. That machine is the
   workspace for code-server and other remote setups, and your computer for desktop VS Code. An
   internal address works, such as a Kubernetes Service
   `http://craft-app-photocraft.apps.svc.cluster.local:8080/`. The next section explains how the
   browser still gets to the app.
2. **Let the editor frame the apps.** Set `EMBED_ORIGINS` on every app container to the origins
   that your editor serves webviews from, separated by commas. A `*` stands for one or more parts
   of the host name. For code-server behind Coder, that is the origin of the workspace apps, for
   example `https://*.code.example.com`. For VS Code on the desktop, add `vscode-webview://*`. The
   app page answers no editor whose origin is missing from the list.
3. **Run the relay.** Run `hayone/craft-mcp` with `MCP_KEY` (a secret of at least 16 characters)
   and `PUBLIC_HOST` (the relay's public address, for example `craft-mcp.example.com`). Set
   `MINT_TOKENS` on craft-mcp to one or more random tokens of at least 16 characters, separated
   by commas.
4. **Give the editor the relay and a token.** Set `craft.relayUrl` (or `CRAFT_RELAY_URL`) to the
   relay's address. Give the editor one of the mint tokens: set `CRAFT_RELAY_TOKEN`, or run
   **Craft: Set the Relay Token**. A mint token can only make relay connections. Without a relay,
   the panels still open and lend the workspace files, but no agent can drive the apps.
5. **Tell the extension where the apps are.** Set `craft.appUrl`, or `CRAFT_APP_URL` in the
   workspace's environment, to an address with `{app}` in it, for example
   `http://craft-app-{app}.apps.svc.cluster.local:8080/` or `https://{app}.example.com/`. An
   address without `{app}` serves every app under `/<app>/`, so `https://craft.example.com` opens
   PhotoCraft at `https://craft.example.com/photocraft/`.

## Apps at an internal address

The panel's page is loaded by your browser, not by the workspace. An internal address, or any
plain `http://` address in an `https://` editor, can't be loaded there. For such an address, the
extension serves the app through a small proxy on a local port of the machine that runs the
extension, and asks the editor for the browser's way to that port (`vscode.env.asExternalUri`).

- On the desktop, the address is `http://localhost:<port>/`.
- In code-server behind Coder, the address is the workspace's port address, for example
  `https://47820--main--dev--alice.code.example.com/`. Coder's own sign-in protects that address,
  so the apps need no sign-in of their own.
- In other remote setups, the editor's port forwarding gives the address.

The setting `craft.appProxy` decides when the proxy is used: `auto` (the default) for `http://`
addresses, `always`, or `never`. Each app gets the same port every time, `craft.proxyPort`
(47820) plus the app's place in the extension's app list, so the app keeps one origin and its
saved settings. A second editor window with the same app uses the first window's proxy, and takes
the port over when the first window closes.

## How a panel gets connected

The panel shows the app's page in an iframe. The extension's part of the panel sends the page a
`craft-embed:hello` message. The page answers its direct parent only, and only when the parent's
origin is allowed (see step 2 above). The hello carries the panel's relay connection, which the
extension made with the relay token, and the page connects to the relay with it. The page then
tells the panel the tab's MCP URL, and the extension keeps an MCP client to that URL. Nothing is
copied by hand.

Each editor window makes its own relay connection for each app. Two windows with the same app
open therefore don't take each other's connection over.

When something is missing, the panel says what it is. A page that doesn't allow the editor names
the origin to add to `EMBED_ORIGINS`. A page without a relay connection says so too.
**Craft: Set an App's MCP URL by Hand** takes a tab's MCP URL from somewhere else, for example from
craft-web-gateway's Connect tab.

## Workspace files

The apps can open and save files in your workspace folders. The extension lends the folders to
the app page, and the page shows them in two places:

- **File › Open and Save.** The apps' file dialog lists a **VS Code** place next to the cloud
  folders, if the apps have any. A document that you open from the workspace keeps its place, so **Save** writes
  the file back without a dialog. The new file shows up in the explorer right away. Inside the
  app, the path of such a file looks like `cloud:workspace/assets/logo.png`.
- **Drag a file onto an app.** Drag a file from the explorer onto an app's name in the **Craft
  Apps** list. The list is a section at the bottom of the Explorer, and it is also in the Craft
  side bar. The app opens, if it isn't open yet, and gets the file as if you had dropped it on the
  app.
- **Open in a Craft App.** Right-click a file in the explorer, choose **Open in a Craft App**, and
  pick the app.
- **The coding agent moves files in and out.** An agent such as Claude Code can send a workspace
  file into any app and copy the files that an app saves back into the workspace. The section
  [Files and the coding agent](#files-and-the-coding-agent) below explains how.

A drag onto the app's panel itself doesn't work, and the cursor shows the "not allowed" sign. VS
Code doesn't pass a drag that starts inside the editor (the explorer, for example) to an
extension's panel, so the panel never sees it. A file dragged from your desktop onto the panel
does reach the app.

Lending the folders means trusting the apps with them. With the default setting, the app page can
overwrite any file that the rules below don't protect, for example `package.json` or a source
file. An AI assistant drives the apps, so a bad instruction to the assistant could lead to such a
save. Use `"readOnly"` if the apps should only open files from the workspace.

These rules always hold:

- The page only reaches files inside the workspace folders. A symbolic link that points out of a
  folder is refused.
- Hidden files and folders, whose names start with a dot (`.git`, `.vscode`, `.env`), are never
  listed, read or written. A page could otherwise change your settings, your tasks or your git
  history. The extension checks the real path on disk, so a link to a hidden folder or a Windows
  short name such as `GIT~1` doesn't get around the rule.
- The page can read files in `node_modules`, but it can't write there. A changed package would
  run the next time a tool loads it.
- A file can have at most 200 MB, and one drop at most 50 files.

The setting `craft.workspaceFiles` picks what the apps may do:

| Value | What the apps may do |
| --- | --- |
| `"readWrite"` (default) | Open files from the workspace folders, and save files into them. |
| `"readOnly"` | Open files from the workspace folders. The dialog shows the place as read-only. |
| `"off"` | Nothing. The dialog doesn't show the place. |

A change to the setting takes effect at once in every open panel. Nothing is lent while the
workspace is in Restricted Mode.

The app page (`craft-embed.js` in the images) passes the requests between the app and the
extension, and only for an editor that it allows. The feature needs app images from November 2026
or later. File › Open and Save use the cloud storage hook, which PhotoCraft and VectorCraft have
today. Opening a dragged file works in every app that accepts dropped files. A container with
`EMBED_FILES=false` doesn't take the editor's files at all.

### Files and the coding agent

The apps run in a browser tab, so an app can't open a file on the workspace's disk by its path,
and a file that an app saves goes to the browser instead of the disk. The desktop apps take the
flags `--automation-read-root` and `--automation-write-root` for an agent's files, but those
flags don't exist in the browser. The extension's MCP server therefore has three tools of its own
that move the files:

| Tool | What it does |
| --- | --- |
| `craft_send_file` | Sends a workspace file into an open app, as if the user had dropped the file on the app. |
| `craft_app_files` | Lists the files that the app saved, exported or rendered in its tab. FilmCraft and EffectCraft also list the files in their own file tables. |
| `craft_get_file` | Copies one of those files into the workspace, at the path that the agent names. |

An agent names a workspace file by an absolute path inside a workspace folder, for example
`/home/coder/project/media/clip.mp4`, or by a path relative to the first workspace folder, for
example `media/clip.mp4`. The rules of the previous section hold here too, and so does the
`craft.workspaceFiles` setting.

To get a file out of an app, the agent first saves or exports it with the app's own tool and any
file name, and then calls `craft_get_file` with that name. While the agent works, the app's tab
keeps the file instead of starting a browser download. The table shows what each app does with a
file that it receives, and which of its tools save a file.

| App | A file sent with `craft_send_file` | Tools that save a file |
| --- | --- | --- |
| PhotoCraft | Opens as a document. | `doc_save`, `doc_export`. These two also take a workspace path directly. |
| VectorCraft | Opens as a document. | `save_file`, `export`. |
| LightCraft | Goes into the library. A dialog in front, such as the Welcome window, holds the file until the dialog closes. | `export`. |
| FilmCraft | Goes into the project as media. A `.fcproj` file opens as the project. | `command_run` with `file.saveAs`, `file.exportFrame` and the other export commands. |
| EffectCraft | Goes into the app's file table at `/<name>`, and the app imports it. A `.ecproj` file opens as the project. | `save_project`, and renders. |

The tab keeps the last 32 files, up to 1 GB in all. A file larger than 200 MB can't be copied
into the workspace. PhotoCraft's `doc_export_layers` and `doc_export_data_sets` write many files
at once and don't work in the browser.

The bytes travel from the extension through the relay (craft-mcp) to the app's tab. The tools
need the craft-mcp relay and the app images from `hayone1/Docker_Images` of November 2026 or later.
An older relay answers that it "doesn't take files".

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

Then set up the apps and tell the extension where they are, as the section
[What the apps need](#what-the-apps-need) describes.

### Coder

In a template that uses Coder's `code-server` module, add the extension to the module's
`extensions` list. The module installs extensions from Open VSX. Then set the apps' address for
the workspace on the agent:

```hcl
module "code-server" {
  source     = "registry.coder.com/coder/code-server/coder"
  agent_id   = coder_agent.main.id
  extensions = ["anthropic.claude-code", "hayone1.craft-vscode"]
}

resource "coder_agent" "main" {
  env = {
    CRAFT_APP_URL = "https://{app}.example.com/"
    # Only when the editor asks the relay itself (MINT_TOKENS on craft-mcp):
    # CRAFT_RELAY_URL   = "https://craft-mcp.example.com"
    # CRAFT_RELAY_TOKEN = var.craft_relay_token
  }
}
```

The template doesn't need to run `claude mcp add`, because the extension sets up the agents
itself. To choose the MCP token yourself, also set `CRAFT_MCP_TOKEN` in the agent's `env`.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `craft.appUrl` | `CRAFT_APP_URL` | Where the apps are, e.g. `https://{app}.example.com/`. `craft.hubUrl` and `CRAFT_HUB_URL`, the names before version 0.5, still work. |
| `craft.relayUrl` | `CRAFT_RELAY_URL` | The relay's address, when the editor asks the relay itself. The token comes from `CRAFT_RELAY_TOKEN` or **Craft: Set the Relay Token**, which keeps the token in the editor's secret storage. |
| `craft.apps` | `CRAFT_APPS`, else the five apps | The apps, in order. |
| `craft.mcpPort` | `47811` | The local MCP server's port. |
| `craft.agents` | `["claude", "codex", "gemini"]` | The coding agents that get the server. |
| `craft.workspaceFiles` | `"readWrite"` | What the app panels may do with the workspace folders: `"readWrite"`, `"readOnly"` or `"off"` (see "Workspace files"). |

## Notes

- **Signing in.** When a proxy in front of the apps signs people in, the panel uses that
  sign-in. If the sign-in page can't show in a frame, press **Sign in** in the panel's note, sign
  in in the browser tab that opens, then **Reload**. The apps and the editor must be on the same
  site (for example `photocraft.example.com` and `*.code.example.com`), or Safari won't send the
  sign-in cookie to the panel.
- **code-server, not "VS Code Web".** code-server serves webviews from the workspace's own
  origin, so the sign-in cookie and the handshake work. Microsoft's VS Code server (`code
  serve-web`) serves them from `vscode-cdn.net`, another site, where Safari blocks the cookie.
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
the token. `src/files.mjs` answers the app pages' file requests. `src/embed.mjs` works out each
app's address and gets relay connections. All four run in plain Node too, and the tests use
temporary folders.

## Release

A tag `v<version>` that matches `version` in `package.json` makes the CI build the `.vsix`,
create a GitHub release, and publish the same `.vsix` to both stores.

- **Visual Studio Marketplace.** The CI uses Trusted Publishing, so the repository holds no
  Marketplace secret. The publisher `hayone1` at https://marketplace.visualstudio.com/manage has
  a Trusted Publishing policy for the owner `hayone1`, the repository `craft-vscode` and the
  workflow `ci.yml`, with no environment. `vsce publish --oidc` trades the run's GitHub OIDC
  token for a Marketplace credential that lasts 15 minutes. Azure DevOps personal access tokens
  that cover all organizations stop working on December 1, 2026, which is why the CI doesn't use
  one.
- **Open VSX.** The CI uses Trusted Publishing here too: `ovsx publish --trusted-publishing`
  trades the run's GitHub OIDC token for an Open VSX token that lasts about 5 minutes. The
  namespace `hayone1` has a trusted publisher for the owner `hayone1`, the repository
  `craft-vscode` and the workflow `ci.yml`, with no environment. Open VSX only trusts a workflow
  for an extension that already has a version, so the first version went up once with an access
  token. If the repository has the secret `OVSX_PAT`, the CI uses that token instead.

`src/bridge.mjs` is the MCP server and its clients (plain Node, tested on its own).
`src/extension.mjs` is the VS Code side: the panels, the Craft view and the window handover.

## License

MIT
