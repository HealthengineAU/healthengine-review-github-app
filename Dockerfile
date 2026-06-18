FROM node:22-bookworm-slim AS base

ENV NODE_ENV=production
WORKDIR /app

FROM base AS dependencies

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM base AS release

ENV HOST=0.0.0.0 \
    PORT=3000 \
    LOG_LEVEL=info

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY app.js ./
COPY lib ./lib

EXPOSE 3000

USER node

CMD ["npm", "run", "start"]
