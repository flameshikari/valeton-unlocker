# syntax=docker/dockerfile:1
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src/ ./src/
COPY tests/ ./tests/
RUN npm test && npm run build

FROM dhi.io/nginx:1.31.8-alpine3.23@sha256:4776f3e4713a1a74d640a7402bd13804962b1b5e2fbcfa149b175177bafb9de5

COPY --from=build /app/dist/ /usr/share/nginx/html/
EXPOSE 8080
