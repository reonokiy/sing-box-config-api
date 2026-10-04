FROM node:24.9.0-alpine3.22@sha256:b0d33ed19a912e1a18ceb83e139815233cd49c123fe025e67a7c506c93e3f728 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24.9.0-alpine3.22@sha256:b0d33ed19a912e1a18ceb83e139815233cd49c123fe025e67a7c506c93e3f728
WORKDIR /app
ARG PROXY_AGENT_IMAGE=ghcr.io/reonokiy/sing-box-config-api:agent-latest
ENV NODE_ENV=production PROXY_AGENT_IMAGE=${PROXY_AGENT_IMAGE}
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY web ./web
COPY agent ./agent
USER node
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "src/main.ts"]
