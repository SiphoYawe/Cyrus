FROM node:22-slim

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies (including native builds)
COPY package*.json ./
RUN npm ci

# Copy source and config
COPY . .

# Build TypeScript
RUN npm run build

# Copy SQL migrations to dist (TypeScript doesn't copy non-TS files)
RUN cp -r src/core/migrations dist/core/migrations 2>/dev/null || true

# Expose ports (REST + WebSocket)
EXPOSE 3001 8080

CMD ["node", "dist/index.js"]
