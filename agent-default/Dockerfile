# Full-stack agent image: extends agent-base with all major language toolchains.
# This is the default "kitchen sink" template — every language pre-installed for
# instant agent VM boot with zero setup.
#
# For lighter, specialized images, use a template that only installs what you need.

ARG AGENT_BASE_IMAGE=ghcr.io/zwrm-eu/agent-base:latest
FROM ${AGENT_BASE_IMAGE}

USER root

# -- Python 3.12 --------------------------------------------------------------
RUN add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
    python3.12 \
    python3.12-dev \
    python3.12-venv \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.12 1 \
    && update-alternatives --install /usr/bin/python python /usr/bin/python3.12 1 \
    && curl -sS https://bootstrap.pypa.io/get-pip.py | python3.12

# -- PostgreSQL Python driver (#1259) -----------------------------------------
RUN python3 -m pip install --no-cache-dir "psycopg[binary]"

# -- Go 1.25 -------------------------------------------------------------------
ENV GOLANG_VERSION=1.25.12
RUN curl -fsSL "https://go.dev/dl/go${GOLANG_VERSION}.linux-amd64.tar.gz" \
    | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"

# -- Document-skills runtime deps (#885) ----------------------------------------
# The built-in xlsx/docx/pptx/pdf skills fetch their instructions at session
# start; these are the tools those instructions drive (derived from the
# pinned anthropics/skills SKILL.mds — soffice/qpdf/poppler/tesseract for
# conversion+inspection, the python libs for authoring, docx/pptxgenjs for
# the skills' JS creation paths).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    poppler-utils \
    qpdf \
    pandoc \
    tesseract-ocr \
    fonts-liberation \
    fonts-dejavu-core \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir \
    openpyxl python-docx python-pptx pypdf pdfplumber reportlab \
    pdf2image pytesseract Pillow lxml defusedxml "markitdown[docx,pptx,xlsx,pdf]"

RUN npm install -g docx pptxgenjs && npm cache clean --force

# -- Rust (system-wide: /usr/local, NOT /home/agent — #1347) --------------------
# Everything under /home/agent is copied into /etc/skel/agent-skel and seeded
# onto every workspace volume forever, so toolchains must live in system paths
# (same pattern as /usr/local/go above). RUSTUP_HOME persists as ENV so the
# rustup proxies in /usr/local/cargo/bin resolve the system toolchain at
# runtime; CARGO_HOME is set ONLY for this RUN — leaving it unset at runtime
# makes per-user cargo state (~/.cargo registry, `cargo install` bins) land on
# the workspace volume. minimal profile: the default profile bakes 917 MB of
# rust-docs HTML no VM agent will ever open. chmod a+w (official rust-image
# pattern) lets agents run `rustup component add` — those writes go to the
# VM's ephemeral overlay, which is acceptable.
ENV RUSTUP_HOME=/usr/local/rustup
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | CARGO_HOME=/usr/local/cargo sh -s -- -y --no-modify-path \
      --default-toolchain stable --profile minimal -c rustfmt -c clippy \
    && chmod -R a+w /usr/local/rustup /usr/local/cargo
ENV PATH="/usr/local/cargo/bin:${PATH}"

# -- Bun (system-wide — #1347) ---------------------------------------------------
# BUN_INSTALL is build-time only: unset at runtime, bun's global installs and
# cache default under ~/.bun on the workspace volume.
# HOME=/root + /usr/local/bun/bin pre-set on PATH keep the installer's
# post-install hands off the seeded agent profile: with the binary already
# findable its `command -v bun` check passes and it skips writing
# BUN_INSTALL/PATH exports into $HOME's shell config — which, with the
# image's inherited HOME=/home/agent, would turn the build-time-only
# variable into a runtime setting on every workspace (#1347 review).
RUN curl -fsSL https://bun.sh/install \
    | HOME=/root PATH="/usr/local/bun/bin:${PATH}" BUN_INSTALL=/usr/local/bun bash
ENV PATH="/usr/local/bun/bin:${PATH}"

# -- Build-residue cleanup (#1347) -----------------------------------------------
# Docker layers don't shrink from a trailing rm, but the ext4 conversion
# flattens via docker export, so this DOES shrink the shipped image — and
# everything removed from /home/agent is removed from the skel copy (and every
# future workspace volume) with it. Caches only — never dotfiles, and never
# /home/agent/.local (the claude native install lives there).
RUN rm -rf /root/.npm /root/.cache \
    /home/agent/.npm /home/agent/.cache /home/agent/.launchpadlib \
    /tmp/* /var/tmp/*

USER agent

# -- Per-user install bins (seeded empty — #1347 review) ------------------------
# The boot PATH discovery only records directories that EXIST at boot. The
# home-installed toolchains used to guarantee ~/.cargo/bin and ~/.bun/bin in
# the skel; with the toolchains system-wide, seed the dirs empty so a later
# `cargo install` / `bun add -g` is on PATH in every shell immediately,
# instead of invisible until a reboot regenerates zwrmd-volume-path.sh.
RUN mkdir -p /home/agent/go/bin /home/agent/.cargo/bin /home/agent/.bun/bin
ENV GOPATH="/home/agent/go"
ENV PATH="/home/agent/go/bin:${PATH}"

# -- Default working directory -------------------------------------------------
WORKDIR /home/agent

CMD ["/bin/bash"]
