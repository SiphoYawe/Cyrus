FROM node:22-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production=false

# Copy source and config
COPY . .

# Build TypeScript
RUN npm run build

# Expose ports (REST + WebSocket)
EXPOSE 3001 8080

CMD ["node", "dist/index.js"]
