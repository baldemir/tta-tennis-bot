import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { getAccessToken } from './auth.js';

export type Feature = { active: boolean; feature: { id: string; name: string; price: number; type: string } };
export type Court = { id: string; name: string; type: string; status: string; is_online_sale: boolean; hourly_price: number; features?: Feature[] };
export type Slot = { courtId: string; date: string; startTime: string; durationMinutes: number };
export type CalendarEvent = { court_id: string; court_name?: string; start_time: string; end_time: string; type: string; status: string };

async function apiGet<T>(path: string): Promise<T> {
  const get = async (token: string) => fetch(config.apiBase + path, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  let response = await get(await getAccessToken());
  // GETs are safe to repeat: on 401 refresh the token once and try again.
  if (response.status === 401) response = await get(await getAccessToken({ force: true }));
  if (!response.ok) throw new Error(`GET ${path.split('?')[0]} failed (${response.status})`);
  return await response.json() as T;
}

export async function fetchCourts(date: string): Promise<Court[]> {
  const query = new URLSearchParams({ limit: '100', offset: '0', with_features: 'true', branch_id: config.branchId, date });
  const response = await apiGet<{ data: { courts: Court[]; total?: number } }>(`/courts/?${query}`);
  if (!Array.isArray(response.data?.courts)) throw new Error('Unexpected courts response');
  if (response.data.total !== undefined && response.data.total > response.data.courts.length) throw new Error('Incomplete courts list; pagination required');
  return response.data.courts.filter(c => c.type === 'INDOOR' && c.status === 'ACTIVE' && c.is_online_sale);
}

export async function fetchCalendarEvents(date: string): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const query = new URLSearchParams({ start_date: date, end_date: date, limit: String(limit), offset: String(offset), branch_id: config.branchId });
    const response = await apiGet<{ data: CalendarEvent[] }>(`/calendar/events/date-range?${query}`);
    if (!Array.isArray(response.data)) throw new Error('Unexpected calendar response');
    events.push(...response.data);
    if (response.data.length < limit) break;
    if (offset >= 9500) throw new Error('Calendar exceeds safety pagination cap');
  }
  return events;
}

export function slotRange(slot: Slot): [number, number] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slot.date) || !/^\d{2}:\d{2}$/.test(slot.startTime)) throw new Error('Invalid slot date/time');
  const [hour, minute] = slot.startTime.split(':').map(Number);
  if (hour > 23 || minute > 59) throw new Error('Invalid start time');
  const start = Date.parse(`${slot.date}T${slot.startTime}:00+03:00`);
  if (!Number.isFinite(start)) throw new Error('Invalid target date');
  return [start, start + slot.durationMinutes * 60_000];
}

export function hasConflict(slot: Slot, events: CalendarEvent[]): boolean {
  const [start, end] = slotRange(slot);
  return events.some(event => {
    if (event.court_id !== slot.courtId) return false;
    const eventStart = Date.parse(event.start_time);
    const eventEnd = Date.parse(event.end_time);
    if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd)) throw new Error('Invalid event timestamp');
    return start < eventEnd && eventStart < end;
  });
}

export function findUnoccupiedCourts(courts: Court[], events: CalendarEvent[], date: string, startTime: string): Court[] {
  return courts.filter(court => !hasConflict({ courtId: court.id, date, startTime, durationMinutes: config.durationMinutes }, events));
}

export function buildReservationPayload(court: Court, slot: Slot) {
  if (!config.firstPlayerId || !config.secondPlayerId) throw new Error('Set TTA_FIRST_PLAYER_ID and TTA_SECOND_PLAYER_ID');
  const lighting = court.features?.find(f => f.active && f.feature?.type === 'LIGHTING');
  if (!lighting) throw new Error(`No active lighting feature returned for ${court.name}`);
  if (!Number.isFinite(court.hourly_price) || !Number.isFinite(lighting.feature.price)) throw new Error('Invalid price returned by court API');
  const [startMs, endMs] = slotRange(slot);
  const asTurkeyOffset = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().replace('Z', '+03:00');
  return {
    resource_id: court.id,
    first_player_id: config.firstPlayerId,
    second_player_id: config.secondPlayerId,
    third_player_id: '',
    fourth_player_id: '',
    branch_id: config.branchId,
    start_time: asTurkeyOffset(startMs),
    end_time: asTurkeyOffset(endMs),
    price: court.hourly_price * (slot.durationMinutes / 60) + lighting.feature.price,
    is_free_reservation: false,
    resource_options: {
      selected_features: [lighting.feature.id],
      features_details: [{ feature_id: lighting.feature.id, feature_name: lighting.feature.name, feature_price: lighting.feature.price }],
    },
  };
}

/** Only HTTP 200 is considered successful, as requested. Never auto-retry a POST. */
export async function createReservation(court: Court, slot: Slot): Promise<void> {
  const accessToken = await getAccessToken();
  const payload = buildReservationPayload(court, slot);
  console.log(`Submitting ${court.name}: ${payload.start_time} -> ${payload.end_time}, price ${payload.price} TRY`);
  const response = await fetch(`${config.apiBase}/reservations/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://rezervasyon.tta.com.tr' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000),
  });
  await saveReservationResponse(slot, payload, response);
  // Do not print the response body: it may contain personal information.
  if (response.status !== 200) throw new Error(`Reservation not confirmed: HTTP ${response.status}. Check account before retrying.`);
}

/**
 * Saves the raw booking response (status, headers, body) plus the request payload to
 * state/responses/, so success detection can later be based on the real response shape.
 * The body may contain personal data: the file is git-ignored and mode 600. Never throws.
 */
async function saveReservationResponse(slot: Slot, payload: object, response: Response): Promise<void> {
  try {
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep raw text */ }
    const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== 'set-cookie'));
    const dir = join('state', 'responses');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${slot.date}-${slot.startTime.replace(':', '')}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
    await writeFile(file, JSON.stringify({ recordedAt: new Date().toISOString(), request: payload, status: response.status, headers, body }, null, 2), { mode: 0o600 });
    console.log(`Booking response saved to ${file}`);
  } catch (error) {
    console.error('Could not save booking response:', error instanceof Error ? error.message : String(error));
  }
}
