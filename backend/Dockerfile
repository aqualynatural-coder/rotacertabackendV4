# ==========================================================
# RotaCerta Backend - Dockerfile multi-stage (production)
# ==========================================================
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# --- Build ---
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# --- Runner ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl bash
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
RUN npx prisma migrate deploy && npx prisma generate
RUN mkdir -p uploads && chown -R node:node /app
EXPOSE 4000

# Entrypoint: aplica migrations, roda seed se necessário e inicia
COPY --chown=node:node docker-entrypoint.sh ./
CMD ["sh", "docker-entrypoint.sh"]
