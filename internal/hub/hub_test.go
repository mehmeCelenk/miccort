package hub

import "testing"

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
