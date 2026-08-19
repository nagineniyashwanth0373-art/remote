FROM node:20-slim

# Install system dependencies (including sharp / canvas support libraries if needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install dependencies (ignoring optional native ones like robotjs on Linux container)
RUN npm install --omit=dev --no-audit

# Copy the rest of application files
COPY . .

# Expose default port
EXPOSE 8080

# Environment setup
ENV NODE_ENV=production
ENV PORT=8080

# Start server
CMD ["node", "server.js"]
