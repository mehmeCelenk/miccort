package hub

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sort"
	"sync"

	"mikcort/internal/room"
)

type Message struct {
	Type         string          `json:"type"`
	RoomID       string          `json:"roomId,omitempty"`
	UserID       string          `json:"userId,omitempty"`
	TargetUserID string          `json:"targetUserId,omitempty"`
	Payload      json.RawMessage `json:"payload,omitempty"`
}

type Client struct {
	UserID      string
	DisplayName string
	RoomID      string
	Send        chan []byte
}

type RoomSummary struct {
	ID    string   `json:"id"`
	Users []string `json:"users"`
}

type Hub struct {
	mu      sync.RWMutex
	rooms   map[string]*room.Room
	clients map[string]map[string]*Client
}

func New() *Hub {
	return &Hub{
		rooms:   make(map[string]*room.Room),
		clients: make(map[string]map[string]*Client),
	}
}

func (h *Hub) Handle(client *Client, msg Message) {
	switch msg.Type {
	case "join-room":
		var payload struct {
			DisplayName string `json:"displayName"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		h.Join(client, msg.RoomID, msg.UserID, payload.DisplayName)
	case "ping":
		client.send(Message{Type: "pong", RoomID: client.RoomID, UserID: client.UserID})
	case "offer", "answer", "ice-candidate":
		h.forward(client, msg)
	default:
		client.send(Message{Type: "error", Payload: rawError("unknown message type")})
	}
}

func (h *Hub) Join(client *Client, roomID string, requestedUserID string, displayName string) {
	if roomID == "" {
		client.send(Message{Type: "error", Payload: rawError("roomId is required")})
		return
	}

	h.mu.Lock()
	if client.RoomID != "" {
		h.leaveLocked(client)
	}

	if requestedUserID == "" {
		requestedUserID = randomID()
	}
	if displayName == "" {
		displayName = "Guest " + requestedUserID[:4]
	}
	client.UserID = requestedUserID
	client.DisplayName = displayName
	client.RoomID = roomID

	r, ok := h.rooms[roomID]
	if !ok {
		r = room.New(roomID)
		h.rooms[roomID] = r
	}
	if _, ok := h.clients[roomID]; !ok {
		h.clients[roomID] = make(map[string]*Client)
	}

	existingUsers := make([]map[string]string, 0, len(r.UserIDs()))
	for _, userID := range r.UserIDs() {
		existing := h.clients[roomID][userID]
		name := ""
		if existing != nil {
			name = existing.DisplayName
		}
		existingUsers = append(existingUsers, map[string]string{
			"id":          userID,
			"displayName": name,
		})
	}
	r.Add(client.UserID)
	h.clients[roomID][client.UserID] = client

	others := make([]*Client, 0, len(h.clients[roomID]))
	for userID, other := range h.clients[roomID] {
		if userID != client.UserID {
			others = append(others, other)
		}
	}
	h.mu.Unlock()

	client.send(Message{
		Type:   "room-users",
		RoomID: roomID,
		UserID: client.UserID,
		Payload: mustJSON(map[string]any{
			"users": existingUsers,
			"self": map[string]string{
				"id":          client.UserID,
				"displayName": client.DisplayName,
			},
		}),
	})

	joined := Message{
		Type:   "user-joined",
		RoomID: roomID,
		UserID: client.UserID,
		Payload: mustJSON(map[string]string{
			"id":          client.UserID,
			"displayName": client.DisplayName,
		}),
	}
	for _, other := range others {
		other.send(joined)
	}
}

func (h *Hub) Leave(client *Client) {
	h.mu.Lock()
	leftRoomID, leftUserID, others := h.leaveLocked(client)
	h.mu.Unlock()

	if leftRoomID == "" || leftUserID == "" {
		return
	}
	left := Message{Type: "user-left", RoomID: leftRoomID, UserID: leftUserID}
	for _, other := range others {
		other.send(left)
	}
}

func (h *Hub) Rooms() []RoomSummary {
	h.mu.RLock()
	defer h.mu.RUnlock()

	rooms := make([]RoomSummary, 0, len(h.rooms))
	for roomID, r := range h.rooms {
		users := make([]string, 0, len(r.UserIDs()))
		for _, userID := range r.UserIDs() {
			client := h.clients[roomID][userID]
			if client == nil {
				continue
			}
			users = append(users, client.DisplayName)
		}
		if len(users) == 0 {
			continue
		}
		sort.Strings(users)
		rooms = append(rooms, RoomSummary{
			ID:    roomID,
			Users: users,
		})
	}

	sort.Slice(rooms, func(i, j int) bool {
		return rooms[i].ID < rooms[j].ID
	})
	return rooms
}

func (h *Hub) forward(client *Client, msg Message) {
	if client.RoomID == "" {
		client.send(Message{Type: "error", Payload: rawError("join a room before signaling")})
		return
	}
	if msg.TargetUserID == "" {
		client.send(Message{Type: "error", Payload: rawError("targetUserId is required")})
		return
	}

	h.mu.RLock()
	target := h.clients[client.RoomID][msg.TargetUserID]
	h.mu.RUnlock()
	if target == nil {
		client.send(Message{Type: "error", Payload: rawError("target user is not in room")})
		return
	}

	msg.RoomID = client.RoomID
	msg.UserID = client.UserID
	target.send(msg)
}

func (h *Hub) leaveLocked(client *Client) (string, string, []*Client) {
	roomID := client.RoomID
	userID := client.UserID
	if roomID == "" || userID == "" {
		return "", "", nil
	}

	roomClients := h.clients[roomID]
	if roomClients != nil && roomClients[userID] != client {
		client.RoomID = ""
		client.UserID = ""
		client.DisplayName = ""
		return "", "", nil
	}

	r := h.rooms[roomID]
	if r != nil {
		r.Remove(userID)
		if r.Empty() {
			delete(h.rooms, roomID)
		}
	}

	delete(roomClients, userID)
	others := make([]*Client, 0, len(roomClients))
	for _, other := range roomClients {
		others = append(others, other)
	}
	if len(roomClients) == 0 {
		delete(h.clients, roomID)
	}

	client.RoomID = ""
	client.UserID = ""
	client.DisplayName = ""
	return roomID, userID, others
}

func (c *Client) send(msg Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	select {
	case c.Send <- data:
	default:
	}
}

func mustJSON(v any) json.RawMessage {
	data, _ := json.Marshal(v)
	return data
}

func rawError(message string) json.RawMessage {
	return mustJSON(map[string]string{"message": message})
}

func randomID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "user"
	}
	return hex.EncodeToString(b[:])
}
