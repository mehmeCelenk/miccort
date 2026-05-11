FROM golang:1.24-alpine AS build

WORKDIR /app
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal

RUN go build -trimpath -ldflags="-s -w" -o /out/mikcort-server ./cmd/server

FROM alpine:3.22

RUN adduser -D -H -u 10001 appuser
USER appuser

EXPOSE 8080
ENV ADDR=:8080

COPY --from=build /out/mikcort-server /mikcort-server
ENTRYPOINT ["/mikcort-server"]
