FROM node:22-slim AS builder

WORKDIR /app

# Prisma needs openssl
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Install dependencies (cached layer)
COPY package*.json ./
RUN npm ci

# Copy source code and generate Prisma Client
COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

# Production image
FROM node:22-slim

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN addgroup --system app && adduser --system --ingroup app app

# Copy built artifacts and dependencies
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Switch to non-root user
USER app

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try { process.exit(JSON.parse(d).status==='ok'?0:1) } catch(e) { process.exit(1) } }); r.on('error',()=>process.exit(1)) })"

# Start the application
CMD ["npm", "run", "start:prod"]
