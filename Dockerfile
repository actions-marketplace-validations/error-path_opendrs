# The opendrs MCP server over stdio, for registries that build and introspect it (Glama) and for
# running it in a container. Mount the repository to score at /repo: docker run -i -v "$PWD:/repo" ...
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build

FROM node:22-slim
# opendrs reads history and diffs with git.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
# A mounted repository is owned by another user; let git read it anyway.
RUN git config --system --add safe.directory '*'
WORKDIR /repo
ENTRYPOINT ["node", "/app/dist/cli/index.js", "mcp"]
