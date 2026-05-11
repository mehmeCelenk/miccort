package main

import (
	"log"
	"net/http"
	"os"

	"mikcort/internal/hub"
	"mikcort/internal/ws"
)

func main() {
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}

	h := hub.New()
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", ws.Handler(h))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	log.Printf("signaling server listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
