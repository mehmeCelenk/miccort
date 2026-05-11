package room

type Room struct {
	ID    string
	Users map[string]bool
}

func New(id string) *Room {
	return &Room{
		ID:    id,
		Users: make(map[string]bool),
	}
}

func (r *Room) Add(userID string) {
	r.Users[userID] = true
}

func (r *Room) Remove(userID string) {
	delete(r.Users, userID)
}

func (r *Room) Empty() bool {
	return len(r.Users) == 0
}

func (r *Room) UserIDs() []string {
	users := make([]string, 0, len(r.Users))
	for userID := range r.Users {
		users = append(users, userID)
	}
	return users
}
