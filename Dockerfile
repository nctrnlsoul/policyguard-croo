# PolicyGuard provider — always-on worker image.
#
# Two stages keep the runtime image small: the builder installs everything and
# compiles TypeScript to dist/; the runtime carries only production deps and the
# compiled output, and runs as a non-root user. No secret is baked in — the
# CROO_* values are supplied at runtime as Fly secrets (env vars by name only).

# ---- build stage ----------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app

# Install deps against the lockfile first so this layer caches across code edits.
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript (tsc) to dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage --------------------------------------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Only production dependencies in the final image (drops typescript, vitest, etc.).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled JavaScript only — no source, no tests, no .env.
COPY --from=build /app/dist ./dist

# Run as the unprivileged user that the node image already provides.
USER node

# The resilient supervisor: connects, listens, auto-reconnects, stays alive.
CMD ["node", "dist/serve.js"]
