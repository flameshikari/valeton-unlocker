# syntax=docker/dockerfile:1
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src/ ./src/
COPY tests/ ./tests/
RUN npm test && npm run build

FROM golang:1.24-alpine AS go-build
WORKDIR /app/server
COPY server/go.mod server/go.sum ./
COPY server/*.go ./
COPY --from=build /app/dist/index.html ./public/index.html
RUN CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /valeton-unlocker .

FROM scratch
COPY --from=go-build /valeton-unlocker /valeton-unlocker
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/valeton-unlocker", "-host", "0.0.0.0"]
