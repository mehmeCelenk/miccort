package hub

import (
	"encoding/json"
	"testing"
)

func TestRoomsListsDisplayNamesAndDropsEmptyRooms(t *testing.T) {
	h := New()
	alice := &Client{Send: make(chan []byte, 4)}
	bob := &Client{Send: make(chan []byte, 4)}

	h.Join(alice, "lounge", "alice-id", "Alice")
	h.Join(bob, "lounge", "bob-id", "Bob")

	rooms := h.Rooms()
	if len(rooms) != 1 {
		t.Fatalf("expected one room, got %d", len(rooms))
	}
	if rooms[0].ID != "lounge" {
		t.Fatalf("expected lounge room, got %q", rooms[0].ID)
	}
	if got, want := rooms[0].Users, []string{"Alice", "Bob"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("expected users %v, got %v", want, got)
	}

	h.Leave(alice)
	h.Leave(bob)

	if rooms := h.Rooms(); len(rooms) != 0 {
		t.Fatalf("expected empty rooms to be removed, got %v", rooms)
	}
}

func TestStaleDuplicateClientLeaveDoesNotRemoveActiveClient(t *testing.T) {
	h := New()
	oldAlice := &Client{Send: make(chan []byte, 8)}
	newAlice := &Client{Send: make(chan []byte, 8)}
	bob := &Client{Send: make(chan []byte, 8)}

	h.Join(oldAlice, "lounge", "alice-id", "Alice")
	h.Join(bob, "lounge", "bob-id", "Bob")
	h.Join(newAlice, "lounge", "alice-id", "Alice")

	h.Leave(oldAlice)

	rooms := h.Rooms()
	if len(rooms) != 1 {
		t.Fatalf("expected stale leave to keep room alive, got %v", rooms)
	}
	if got, want := rooms[0].Users, []string{"Alice", "Bob"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("expected active users %v, got %v", want, got)
	}

	h.Leave(newAlice)
	rooms = h.Rooms()
	if len(rooms) != 1 {
		t.Fatalf("expected Bob to remain after active Alice leaves, got %v", rooms)
	}
	if got, want := rooms[0].Users, []string{"Bob"}; len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("expected users %v, got %v", want, got)
	}
}

func TestChatMessageBroadcastsToRoomPeers(t *testing.T) {
	h := New()
	alice := &Client{Send: make(chan []byte, 8)}
	bob := &Client{Send: make(chan []byte, 8)}

	h.Join(alice, "lounge", "alice-id", "Alice")
	h.Join(bob, "lounge", "bob-id", "Bob")
	drain(alice.Send)
	drain(bob.Send)

	h.Handle(alice, Message{
		Type:    "chat-message",
		Payload: mustJSON(map[string]string{"text": "selam"}),
	})

	var got Message
	select {
	case data := <-bob.Send:
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatalf("failed to decode chat message: %v", err)
		}
	default:
		t.Fatal("expected Bob to receive chat message")
	}

	if got.Type != "chat-message" || got.RoomID != "lounge" || got.UserID != "alice-id" || got.TargetUserID != "" {
		t.Fatalf("unexpected chat message envelope: %+v", got)
	}

	select {
	case data := <-alice.Send:
		t.Fatalf("expected Alice not to receive her own chat echo, got %s", string(data))
	default:
	}
}

func drain(ch <-chan []byte) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}
