import type { UserSummary } from './types';

export function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

export function registerUserName(user: string | UserSummary, userNames: Record<string, string>) {
  if (typeof user === 'string') {
    return user;
  }

  userNames[user.id] = user.displayName || guestName(user.id);
  return user.id;
}

export function displayNameForUser(
  userId: string,
  currentUserId: string,
  currentDisplayName: string,
  userNames: Record<string, string>,
) {
  return userNames[userId] || (userId === currentUserId ? currentDisplayName : guestName(userId));
}

export function initialsForName(name: string) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  return letters || 'M';
}

function guestName(userId: string) {
  return `Guest ${userId.slice(0, 4)}`;
}
