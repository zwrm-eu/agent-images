# Agent Base Image

Base image for ZWRM agent templates. Provides common infrastructure so template authors only need to add their language toolchains.

## Quick Start

Create a custom agent template by extending this image:

```dockerfile
FROM ghcr.io/zwrm-eu/agent-base:latest

USER root
RUN apt-get update && apt-get install -y python3 python3-pip
USER agent
RUN pip install numpy pandas jupyter
```

Push to GitHub and use it:

```bash
zwrm agent create my-agent --runtime claude --template github.com/yourname/your-template
zwrm agent connect my-agent
```

## What's Included

- **Ubuntu 22.04** with build-essential, curl, git, jq, tmux, vim, ripgrep
- **Node.js 22** with corepack
- **GitHub CLI** (`gh`)
- **Claude Code**, **Codex**, and **pi** pre-installed. Claude is the native
  install in the agent home (it floats: seeded onto the workspace volume and
  self-updating there; harness sessions drive the same binary, override with
  `ZWRM_CLAUDE_BIN`). Codex is a pinned global npm package. `pi` is a symlink
  into zwrm-agentd's `node_modules` — its version is pinned by
  `agentd/package.json`, so `npm ls -g` no longer lists it (#1347).
- **SSH server** configured for key-based auth
- **`agent` user** with passwordless sudo
- **Credential storage** (gnome-keyring for OAuth token persistence)
- **Platform instructions** (CLAUDE.md / instructions.md that teach AI assistants to deploy with `zwrm`)

## Writing a Template

Create a GitHub repo with:

```
your-template/
  Dockerfile              # Extends this base image
  zwrm-template.toml      # Optional metadata
  README.md
```

### Example Dockerfile

```dockerfile
FROM ghcr.io/zwrm-eu/agent-base:latest

USER root

# Add your toolchain
RUN apt-get update && apt-get install -y python3.12 python3.12-venv python3-pip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

USER agent

# Install packages as the agent user
RUN pip install --user torch numpy pandas scikit-learn jupyter
```

### Optional Metadata (`zwrm-template.toml`)

```toml
[template]
name = "Python ML"
description = "Python machine learning environment with PyTorch"
author = "yourname"
icon = "brain"
tags = ["python", "ml", "pytorch"]
default_size = "performance-4x"
min_size = "performance-2x"
```

## Shipping MCP Servers With a Template

A template can give every agent session extra tools by declaring local (stdio)
MCP servers. Drop one JSON manifest per server into `/etc/zwrm/mcp.d/`; the
filename is the server name, and its tools appear to the model as
`mcp__<name>__<tool>` on every harness (Claude, Codex, OpenCode, pi):

```dockerfile
USER root
RUN npm install -g @playwright/mcp@0.0.83 \
 && mkdir -p /etc/zwrm/mcp.d \
 && echo '{"command": "/usr/local/bin/playwright-mcp", "args": ["--headless"]}' \
      > /etc/zwrm/mcp.d/browser.json
USER agent
```

Manifest fields: `command` (absolute path, required), `args` (string array),
`env` (string map, merged over the session environment), and `escalate`
(`true` makes the server's tools pause for approval on unattended runs).
Names follow connector slug rules (lowercase letters, digits, dashes); `zwrm`
and `platform` are reserved, and a connector with the same name takes
precedence. Install the server into the image — a command that downloads on
first use (`npx -y ...`) misses the startup budget and is skipped.

## Tips

- Always switch to `USER root` for `apt-get`, then back to `USER agent` for user-space installs
- Home directory contents are automatically seeded into the agent's persistent volume on first boot — no extra setup needed
- **Install toolchains under `/usr/local`, not the home directory** (#1347):
  everything in `/home/agent` is copied into the image's skel and re-seeded
  onto every workspace volume forever, so a home-dir toolchain is paid three
  times. See `templates/agent-default/Dockerfile` for the pattern
  (`/usr/local/go`, `RUSTUP_HOME=/usr/local/rustup`, `BUN_INSTALL=/usr/local/bun`
  at build time only). Keep the home dir for small configs and dotfiles.
- The persistent volume means installed packages in `~/.local`, configs, and project files survive across sessions
