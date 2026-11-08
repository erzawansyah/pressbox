FROM node:22-alpine
# docker-cli: orchestrate sandboxes through the mounted socket. sqlite: sanitize cloned DBs.
RUN apk add --no-cache docker-cli sqlite
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
# Official WordPress Agent Skills (GPL, unmodified) read by the agent at runtime via wp_guide.
COPY knowledge ./knowledge
ENV NODE_ENV=production
EXPOSE 3000 3001
CMD ["node", "src/server.js"]
