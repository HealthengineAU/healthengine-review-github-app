# Multi-stage build for the github-bot-ai-reviewed-prs Probot app.
FROM node:22-bookworm-slim AS base

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies in a dedicated stage for layer caching.
FROM base AS dependencies

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Final runtime image.
FROM base AS release

# Probot binds to localhost by default; bind to all interfaces in-cluster.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    LOG_LEVEL=info

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY app.js ./
COPY lib ./lib

EXPOSE 3000

USER node

# `npm run start` => `probot run ./app.js`
CMD ["npm", "run", "start"]
