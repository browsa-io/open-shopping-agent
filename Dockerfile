# Open Shopping Agent web app (osa web) on node:22-slim, as a non-root user.
#
#   docker build -t open-shopping-agent .
#   docker run -p 8080:8080 -v osa-data:/data -e BROWSA_API_KEY=... -e OSA_WEB_TOKEN=pick-a-long-secret open-shopping-agent
#   open http://localhost:8080/?token=pick-a-long-secret
#
# Settings, history and watches live in /data (OSA_HOME); mount a volume to keep them.
# Off localhost the app always needs a token: set OSA_WEB_TOKEN, or read the generated one from the logs.
#
# Render:  New Web Service from this repo, runtime Docker, port 8080, a 1 GB disk at /data, env BROWSA_API_KEY and OSA_WEB_TOKEN.
# Fly.io:  fly launch --internal-port 8080 --no-deploy && fly volumes create osa_data --size 1 \
#          && fly secrets set BROWSA_API_KEY=... OSA_WEB_TOKEN=... && fly deploy   (mount osa_data at /data in fly.toml)
#
# Not Vercel: a run lasts minutes, waits for your approval in memory and streams over SSE, so it needs one long-lived process.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production OSA_HOME=/data HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY web ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/cli/index.js", "web"]
