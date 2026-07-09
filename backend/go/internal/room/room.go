package room

type Room struct {
	ID       string
	Password string
	Users    map[string]bool
}

func New(id string, password string) *Room {
	return &Room{
		ID:       id,
		Password: password,
		Users:    make(map[string]bool),
	}
}

func (r *Room) Locked() bool {
	return r.Password != ""
}

func (r *Room) PasswordMatches(password string) bool {
	return !r.Locked() || r.Password == password
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
