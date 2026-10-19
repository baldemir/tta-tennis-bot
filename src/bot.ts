import { existsSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { notify } from './notify.js';
import { getAccessToken } from './auth.js';
import { createReservation, fetchCourts, fetchCalendarEvents, findUnoccupiedCourts, buildReservationPayload, type Slot } from './tta.js';

export function targetDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (part: string) => Number(parts.find(p => p.type === part)?.value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day') + config.daysAhead)).toISOString().slice(0, 10);
}

let running = false;
/** isLastAttempt: true when no later attempt is scheduled today, so "no slot" is reported to Slack. */
export async function runBot({ isLastAttempt = true } = {}) {
  if (running) { console.log('Already running'); return; }
  running = true;
  let date = '';
  let postSent = false;
  try {
    date = targetDate();
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (!config.bookingWeekdays.includes(weekday)) {
      const name = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
      console.log(`Skipping ${date} (${name}): not a booking day.`);
      // Keep the session alive between booking days: refreshes only if the access token is expiring.
      await getAccessToken();
      return;
    }
    // A later attempt (e.g. the 00:31 retry) does nothing once a booking request was sent for this date.
    const marker = join('state', `${date}.json`);
    if (!config.dryRun && existsSync(marker)) { console.log(`Booking request already sent for ${date} (${marker}); nothing to do.`); return; }
    console.log(`Checking ${date} ${config.startTimes.join(' then ')}, ${config.durationMinutes} min | dryRun=${config.dryRun}`);
    const [courts, events] = await Promise.all([fetchCourts(date), fetchCalendarEvents(date)]);
    const rank = (name: string) => name === 'CENTER' ? 0 : /^KAPALI \d+$/.test(name) ? Number(name.slice(7)) : 100;
    courts.sort((a, b) => rank(a.name) - rank(b.name));
    console.log(`${events.length} calendar events; ${courts.length} indoor courts`);
    let pick: { court: (typeof courts)[number]; startTime: string } | undefined;
    for (const startTime of config.startTimes) {
      const choices = findUnoccupiedCourts(courts, events, date, startTime);
      for (const court of courts) console.log(`${startTime} ${choices.some(c => c.id === court.id) ? 'NO CALENDAR CONFLICT' : 'BLOCKED'}: ${court.name}`);
      if (choices.length) { pick = { court: choices[0], startTime }; break; }
    }
    if (!pick) {
      const message = `No indoor courts without calendar conflicts at ${config.startTimes.join(' or ')}.`;
      console.log(message);
      if (isLastAttempt) await notify(`:x: TTA: no court booked for ${date}. ${message} Gave up for today.`);
      return;
    }
    // Only the first choice is attempted, to avoid accidentally creating multiple reservations.
    const { court, startTime } = pick;
    const slot: Slot = { courtId: court.id, date, startTime, durationMinutes: config.durationMinutes };
    const payload = buildReservationPayload(court, slot);
    if (config.dryRun) {
      console.log(`DRY_RUN: would book ${court.name}, ${payload.start_time} -> ${payload.end_time}, price ${payload.price} TRY, lighting included; no POST sent.`);
      await notify(`:information_source: TTA: would book ${court.name} on ${date} ${startTime}, ${payload.price} TRY. No booking sent.`);
      return;
    }
    // Atomic file guard survives process restarts. One guard per date, so a rerun can never book
    // the fallback time after an earlier attempt. If POST times out or returns a non-200,
    // inspect the reservation on the website before manually removing the guard.
    await mkdir('state', { recursive: true });
    let handle;
    try { handle = await open(marker, 'wx', 0o600); }
    catch (error: any) {
      if (error?.code === 'EEXIST') { console.log('Already attempted a booking for this date; refusing duplicate POST.'); return; }
      throw error;
    }
    await handle.writeFile(JSON.stringify({ date, startTime, court: court.name, status: 'ATTEMPTED', recordedAt: new Date().toISOString() }, null, 2));
    await handle.close();
    postSent = true;
    await createReservation(court, slot);
    await writeFile(marker, JSON.stringify({ date, startTime, court: court.name, status: 'HTTP_200', recordedAt: new Date().toISOString() }, null, 2));
    console.log(`HTTP 200: reservation submitted for ${court.name}. Check website for final booking/payment state.`);
    await notify(`:white_check_mark: TTA: booked ${court.name} on ${date} ${startTime}, ${payload.price} TRY. Check the website for final booking/payment state.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('BOT FAILED:', message);
    process.exitCode = 1;
    if (postSent) await notify(`:warning: TTA: booking request for ${date} was sent but not confirmed: ${message}. It may or may not have gone through. Check the website; no more attempts will be made for this date.`);
    else await notify(`:x: TTA: run failed${date ? ` for ${date}` : ''}: ${message}.${isLastAttempt ? ' Gave up for today.' : ' Will retry in 30 minutes.'}`);
  } finally { running = false; }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await runBot();
