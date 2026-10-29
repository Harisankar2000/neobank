# Builds the API image. The same image runs the worker with a different command.
# Build from the repository root: docker build -f apps/api/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app
# Workspace manifests first, so `npm ci` is cached until dependencies change.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps/api apps/api
RUN npm run build -w apps/api \
 && npm prune --omit=dev \
 && mkdir -p apps/api/node_modules

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
WORKDIR /app/apps/api
USER node
EXPOSE 3100
# Migrations run automatically when the API starts.
CMD ["node", "dist/server.js"]
