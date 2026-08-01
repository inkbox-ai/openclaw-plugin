FROM node:22-bookworm-slim

ARG OPENCLAW_VERSION=2026.5.27

RUN npm install --global "openclaw@${OPENCLAW_VERSION}"

WORKDIR /opt/inkbox-plugin-src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV HOME=/root
CMD ["sleep", "infinity"]
