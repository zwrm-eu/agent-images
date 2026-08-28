# ZWRM agent images

Source for the VM images that power [ZWRM](https://zwrm.eu) coding agents:

| Directory | Image | Where it's built |
|---|---|---|
| [`agent-base/`](agent-base/) | [`ghcr.io/zwrm-eu/agent-base`](https://github.com/zwrm-eu/agent-images/pkgs/container/agent-base) | GitHub Actions, published on every change |
| [`agent-default/`](agent-default/) | the default "kitchen sink" agent image | on each ZWRM control plane, from this Dockerfile |

> **This is a read-only mirror.** The source of truth lives in ZWRM's private
> platform repository and is synced here automatically on every merge, so
> what you read here is exactly what the published images are built from.
> **Issues are welcome**; pull requests are closed automatically — if you want
> a change, open an issue instead.

## Extending agent-base

`agent-base` is the public base for custom agent templates. Create a GitHub
repo containing a Dockerfile:

```dockerfile
FROM ghcr.io/zwrm-eu/agent-base:latest

USER root
RUN apt-get update && apt-get install -y --no-install-recommends YOUR_PACKAGES \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
USER agent
```

then point an agent at it:

```
zwrm agent create NAME --runtime zwrm --template github.com/OWNER/REPO
```

### What's in agent-base

- Ubuntu 22.04 with build-essential, git, curl, jq, tmux, vim, ripgrep, fd-find
- Node.js 22 (with corepack), GitHub CLI, PostgreSQL 16 client
- Claude Code, OpenAI Codex, and pi (see the version model below)
- `zwrm` CLI and `zwrm-agentd` (the in-VM session daemon, in [`agent-base/agentd/`](agent-base/agentd/))
- SSH server (key-based auth), non-root `agent` user with passwordless sudo,
  gnome-keyring for OAuth token persistence

`agent-default` adds the full toolchain set: Python 3.12, Go, Rust
(minimal profile + rustfmt + clippy), Bun, and a document-processing stack
(LibreOffice, pandoc, poppler, tesseract, plus Python/npm document libraries).

## Version model

- **Claude Code floats.** Each workspace carries ONE claude installation — the
  native install seeded onto the workspace volume, self-updating at runtime.
  Interactive logins and harness (SDK) sessions run the same binary, so a
  Claude CLI release never requires an image rebuild.
- **Codex and pi are pinned deliberately.** Codex because the session daemon
  speaks its experimental app-server protocol version-for-version; pi because
  it ships inside `agentd`'s `node_modules` (pinned in `agentd/package.json`)
  with `/usr/local/bin/pi` symlinked into that tree.

## Toolchain placement (important for template authors)

Install toolchains under **system paths** (`/usr/local/...`), never under
`/home/agent`. Everything in `/home/agent` is copied into the image's skel and
re-seeded onto **every workspace volume, forever** — a 1.5 GB toolchain in the
home dir is paid in the image, in the skel, and on every volume. See
[`agent-default/Dockerfile`](agent-default/Dockerfile) for the pattern
(`/usr/local/go`, `RUSTUP_HOME=/usr/local/rustup`, `BUN_INSTALL=/usr/local/bun`
at build time only); per-user state (`~/.cargo` registry, `~/.bun` globals)
still lands on the workspace volume at runtime.

## Tags

```
ghcr.io/zwrm-eu/agent-base:latest    # tracks every published build
ghcr.io/zwrm-eu/agent-base:YYYY-MM   # dated alias, pin for reproducibility
```

## License

[MIT](LICENSE).
