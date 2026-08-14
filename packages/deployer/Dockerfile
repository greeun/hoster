FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/deployer/package.json packages/deployer/
RUN pnpm install --frozen-lockfile --filter @hoster/deployer
COPY packages/deployer packages/deployer
RUN pnpm --filter @hoster/deployer build

FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY --from=build /app/pnpm-workspace.yaml /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/packages/deployer/package.json packages/deployer/
RUN pnpm install --frozen-lockfile --filter @hoster/deployer --prod
COPY --from=build /app/packages/deployer/dist packages/deployer/dist
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "packages/deployer/dist/index.js"]
