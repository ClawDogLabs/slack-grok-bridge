# Build from the REPO ROOT so the shared relay module is included:
#   docker build -f node-http-relay/Dockerfile -t slack-grok-relay .
FROM node:20-alpine
WORKDIR /app
COPY cloudflare-relay/src ./cloudflare-relay/src
COPY node-http-relay/server.js node-http-relay/package.json ./node-http-relay/
WORKDIR /app/node-http-relay
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
