# Multi-Stage Dockerfile für MintRip Studio (Webapp + Express API)
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY index.html tsconfig.json vite.config.ts metadata.json ./
COPY src ./src
COPY public ./public

RUN npm run build

FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=builder /app/dist ./dist
COPY server.ts metadata.json ./
COPY linux_mint_app ./linux_mint_app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.ts"]
