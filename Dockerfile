FROM node:22-bookworm-slim

ARG OPENCLAW_VERSION=2026.5.27

RUN npm install --global "openclaw@${OPENCLAW_VERSION}"

WORKDIR /opt/inkbox-plugin-src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npx --yes pnpm@10.28.0 install --frozen-lockfile
COPY . .
RUN npm run build

ENV HOME=/root
CMD ["sleep", "infinity"]
