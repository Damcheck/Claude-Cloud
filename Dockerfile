# Sandbox image for Cipher and Forge (Cloudflare Sandbox SDK). Keep the tag in sync
# with the @cloudflare/sandbox version in package.json.
FROM docker.io/cloudflare/sandbox:0.12.10

# Tools the engineers commonly need in addition to the base image's Node, Python and git.
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep jq \
  && rm -rf /var/lib/apt/lists/*
