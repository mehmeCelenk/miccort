package ws

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"

	"mikcort/internal/hub"
)

const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

func Handler(h *hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isWebSocketRequest(r) {
			http.Error(w, "expected websocket upgrade", http.StatusBadRequest)
			return
		}

		key := r.Header.Get("Sec-WebSocket-Key")
		if key == "" {
			http.Error(w, "missing websocket key", http.StatusBadRequest)
			return
		}

		hijacker, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "websocket hijack unsupported", http.StatusInternalServerError)
			return
		}

		conn, rw, err := hijacker.Hijack()
		if err != nil {
			return
		}

		accept := acceptKey(key)
		_, _ = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\n")
		_, _ = fmt.Fprintf(rw, "Upgrade: websocket\r\n")
		_, _ = fmt.Fprintf(rw, "Connection: Upgrade\r\n")
		_, _ = fmt.Fprintf(rw, "Sec-WebSocket-Accept: %s\r\n\r\n", accept)
		if err := rw.Flush(); err != nil {
			_ = conn.Close()
			return
		}

		client := &hub.Client{Send: make(chan []byte, 16)}
		done := make(chan struct{})
		go writeLoop(conn, client.Send, done)
		readLoop(conn, h, client)
		h.Leave(client)
		close(done)
		_ = conn.Close()
	}
}

func readLoop(conn net.Conn, h *hub.Hub, client *hub.Client) {
	reader := bufio.NewReader(conn)
	for {
		opcode, payload, err := readFrame(reader)
		if err != nil {
			return
		}
		switch opcode {
		case 0x1:
			var msg hub.Message
			if err := json.Unmarshal(payload, &msg); err != nil {
				client.Send <- []byte(`{"type":"error","payload":{"message":"invalid json"}}`)
				continue
			}
			h.Handle(client, msg)
		case 0x8:
			return
		case 0x9:
			_ = writeFrame(conn, 0xA, payload)
		}
	}
}

func writeLoop(conn net.Conn, send <-chan []byte, done <-chan struct{}) {
	for {
		select {
		case payload := <-send:
			if err := writeFrame(conn, 0x1, payload); err != nil {
				return
			}
		case <-done:
			_ = writeFrame(conn, 0x8, nil)
			return
		}
	}
}

func isWebSocketRequest(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade")
}

func acceptKey(key string) string {
	sum := sha1.Sum([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func readFrame(r *bufio.Reader) (byte, []byte, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(r, header); err != nil {
		return 0, nil, err
	}

	opcode := header[0] & 0x0F
	masked := header[1]&0x80 != 0
	length := uint64(header[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}

	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return 0, nil, err
		}
	} else {
		return 0, nil, errors.New("client frame must be masked")
	}

	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}

	return opcode, payload, nil
}

func writeFrame(w io.Writer, opcode byte, payload []byte) error {
	header := []byte{0x80 | opcode}
	length := len(payload)
	switch {
	case length < 126:
		header = append(header, byte(length))
	case length <= 65535:
		header = append(header, 126, byte(length>>8), byte(length))
	default:
		header = append(header, 127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(length))
		header = append(header, ext[:]...)
	}
	if _, err := w.Write(header); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}
