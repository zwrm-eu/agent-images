# Agent base image: common plumbing for all agent templates.
# Template authors extend this with their language toolchains.
#
#   FROM ghcr.io/zwrm-eu/agent-base:latest
#   USER root
#   RUN apt-get update && apt-get install -y python3
#   USER agent
#
# The skel copy (for volume seeding) is handled automatically by the build pipeline.
# Template Dockerfiles do NOT need to include it.

FROM ubuntu:22.04

# Points at the PUBLIC read-only mirror (#1348), not this repo: GitHub uses
# this label to connect the ghcr package to a repository, and only a public
# repo renders a README/Dockerfile on the package page. The mirror is synced
# from templates/ by .github/workflows/mirror-agent-images.yml.
LABEL org.opencontainers.image.source="https://github.com/zwrm-eu/agent-images"
LABEL org.opencontainers.image.description="Public base for custom ZWRM agent images. Includes Ubuntu 22.04; Node.js 22; Pi, Claude Code, Codex, zwrm CLI and zwrm-agentd; SSH; Git and GitHub CLI; PostgreSQL 16 client; build tools; jq, tmux, ripgrep, sudo; and a non-root agent user. Extend it with: FROM ghcr.io/zwrm-eu/agent-base:latest; USER root; RUN apt-get update && apt-get install -y YOUR_PACKAGES; USER agent. Commit that Dockerfile to GitHub, then run: zwrm agent create NAME --runtime zwrm --template github.com/OWNER/REPO"

ENV DEBIAN_FRONTEND=noninteractive

# -- System packages -----------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    fd-find \
    git \
    gnupg \
    jq \
    less \
    lsb-release \
    openssh-server \
    pkg-config \
    ripgrep \
    software-properties-common \
    sudo \
    tmux \
    unzip \
    vim \
    wget \
    zip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# -- PostgreSQL 16 client (#1259) ---------------------------------------------
# Keep psql's major version aligned with the managed Postgres image. Ubuntu
# 22.04 only ships v14, so install v16 from PostgreSQL's official apt repo.
RUN curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/keyrings/postgresql-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/postgresql-archive-keyring.gpg] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    | tee /etc/apt/sources.list.d/pgdg.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# -- Node.js 22 (required for Codex; pi requires >= 22.19, #1063) --------------
ENV NODE_VERSION=22.23.1
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
    && corepack enable

# -- Credential storage (for Claude Code OAuth token persistence) --------------
RUN (apt-get update || true) && apt-get install -y --no-install-recommends \
    dbus dbus-x11 gnome-keyring libsecret-1-0 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# -- GitHub CLI ----------------------------------------------------------------
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# -- Non-root agent user with passwordless sudo --------------------------------
RUN useradd -m -s /bin/bash agent \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
    && chmod 0440 /etc/sudoers.d/agent

# -- OpenAI Codex (global npm package, PINNED — #1088) -------------------------
# bubblewrap backs codex's own workspace-write sandbox (permission mode
# 'default'). Without it on PATH codex logs an error on every app-server start
# and falls back to a bundled sandbox — install it rather than ship that.
RUN (apt-get update || true) && apt-get install -y --no-install-recommends bubblewrap \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
# Pinned because the codex harness driver (agentd drivers/codex.mjs) speaks the
# app-server's JSON-RPC protocol, which is experimental and versioned with this
# binary — an unpinned upgrade could change the wire under a shipped daemon.
# The driver adds no npm dependency of its own: this binary IS the SDK, so this
# pin is the whole lockstep. Bump it deliberately, and re-run
# `codex app-server generate-json-schema` to refresh the driver's fixture.
RUN npm install -g @openai/codex@0.145.0 && npm cache clean --force

# -- Pi coding agent (PINNED via agentd — #1062/#1063/#1347) --------------------
# pi ships ONLY inside agentd's node_modules (agentd/package.json pins it);
# /usr/local/bin/pi is a symlink into that tree, created in the agentd layer
# below. One pin instead of the former two (global npm + agentd) — the #1063
# lockstep is now automatic. The profile.d entry stops pi's npm version ping
# on every start (egress-controlled VMs must not stall on it);
# ~/.pi/agent/settings.json is seeded by the VM init, not baked here.
RUN echo 'export PI_SKIP_VERSION_CHECK=1' > /etc/profile.d/pi-env.sh

# -- OpenCode (PINNED single binary — #1390) ------------------------------------
# Bun-compiled standalone binary; no npm tree — the platform package's tarball
# carries the one file. The agentd opencode driver (drivers/opencode.mjs)
# speaks this binary's HTTP+SSE surface, which is versioned with it, so this
# pin is the whole lockstep (the codex rule above): bump deliberately,
# re-probe the surface, and refresh the driver's fixtures. The profile.d
# entries keep gateway-only VMs (#1024) from stalling on its autoupdate,
# models.dev fetch, and LSP downloads.
RUN curl -fsSL https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-1.18.25.tgz -o /tmp/opencode.tgz \
    && tar -xzf /tmp/opencode.tgz -C /tmp package/bin/opencode \
    && install -m 0755 /tmp/package/bin/opencode /usr/local/bin/opencode \
    && rm -rf /tmp/opencode.tgz /tmp/package
RUN printf 'export OPENCODE_DISABLE_AUTOUPDATE=1\nexport OPENCODE_DISABLE_MODELS_FETCH=1\nexport OPENCODE_DISABLE_LSP_DOWNLOAD=1\n' > /etc/profile.d/opencode-env.sh

# -- zwrm CLI (from official releases) ----------------------------------------
# Baseline only: this resolves "latest" when the layer is BUILT and the cached
# layer then freezes it (#968). For the default agent image the control
# plane's build pipeline overwrites it with the release-matched binary at
# rootfs assembly (injectCLI). Custom-template builds do NOT get that
# injection yet and still inherit this baked copy (#970).
RUN curl -fsSL https://releases.zwrm.eu/zwrmd/install.sh | bash -s -- --cli

# -- Agent-user installs -------------------------------------------------------
USER agent
ENV HOME=/home/agent

# -- Claude Code (native installer) -------------------------------------------
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/agent/.local/bin:${PATH}"

# -- SSH server configuration --------------------------------------------------
USER root
RUN mkdir -p /var/run/sshd \
    && sed -i 's/#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/#*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && mkdir -p /home/agent/.ssh \
    && chmod 700 /home/agent/.ssh \
    && chown agent:agent /home/agent/.ssh

# -- Interactive sessions: in-VM session daemon (#709) --------------------------
# zwrm-agentd hosts Claude Agent SDK sessions behind an HTTP API on :9924.
# Launched at boot by the VM init (as the non-root agent user) when the boot
# config carries a session_daemon spec; inert otherwise.
COPY agentd /opt/zwrm-agentd
# Harness Claude sessions use the workspace's native install via
# pathToClaudeCodeExecutable (drivers/claude.mjs, #1347), so BOTH SDK-bundled
# CLI copies (~470 MB) are dead weight — the linux-x64 pair lands only because
# npm's os/cpu optionalDependency gates have no libc dimension. Prune them in
# the SAME layer as npm ci. NEVER use --omit=optional instead: pi's nested
# optional platform deps (clipboard binaries) must survive.
# The test -x guards that the native claude launcher exists — this image must
# never ship claude-less.
RUN cd /opt/zwrm-agentd && npm ci --omit=dev \
    && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 \
              node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl \
    && test -x /home/agent/.local/bin/claude \
    && test -x node_modules/.bin/pi \
    && ln -sfn /opt/zwrm-agentd/node_modules/.bin/pi /usr/local/bin/pi \
    && npm cache clean --force \
    && install -m 0755 zwrm-agentd /usr/local/bin/zwrm-agentd \
    && install -m 0755 zwrm-reclaim /usr/local/sbin/zwrm-reclaim

# -- Default working directory -------------------------------------------------
WORKDIR /home/agent
USER agent

CMD ["/bin/bash"]
