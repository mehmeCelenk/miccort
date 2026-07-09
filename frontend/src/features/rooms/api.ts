import type { RoomSummary } from './types';

export function buildRoomsEndpoint(value: string) {
  try {
    const url = new URL(value.trim());
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/rooms';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

export async function fetchLiveRooms(endpoint: string) {
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Room list failed with ${response.status}`);
  }

  const data = (await response.json()) as { rooms?: RoomSummary[] };
  return (data.rooms ?? []).filter((room) => room.locked || room.users.length > 0);
}
