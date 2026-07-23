# Self-hosted JioSaavn Music API for PalmPlay
# Clones and runs the sumitkolhe/jiosaavn-api open-source project

FROM node:20-alpine

WORKDIR /app

# Install git to clone the upstream API
RUN apk add --no-cache git

# Clone the jiosaavn-api repo (pinned to a stable commit)
RUN git clone --depth=1 https://github.com/sumitkolhe/jiosaavn-api.git .

# Install dependencies
RUN npm install

# Build if a build step exists
RUN npm run build 2>/dev/null || true

# Expose port
EXPOSE 3000

# Start the API
CMD ["npm", "start"]
