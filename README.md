# TTA tennis booking bot

Configuration: **indoor**, 20:00–21:00 Europe/Istanbul (falls back to 21:00–22:00 if no indoor court is free at 20:00), **3 calendar days ahead**, **Tuesdays and Thursdays only** (the bot runs daily at 00:01 Turkey time, but only acts on Saturday and Monday nights, when the target date is a Tuesday or Thursday). CENTER first, then KAPALI 10–14 (based on the returned courts list). **Lighting enabled**, **2 players**.

## Setup

Requires Node.js 20+.

```sh
npm install
cp .env.example .env
# Add freshly issued access token and both player UUIDs to .env.
npm run check
npm run dry-run
```

The dry run reads both observed GET endpoints and prints the selected court and price, without posting any reservation. The example POST has a different time (18:00–19:00); the bot uses 20:00–21:00, or 21:00–22:00 as fallback (+03:00).

After checking the expected date, court, price and player IDs:

```sh
# Edit .env: DRY_RUN=false
npm run run       # manual live run for the date 3 days ahead
npm run schedule  # persistent scheduler at 00:01 Europe/Istanbul
```

Only use `npm run run` when a reservation is actually intended. The service attempts at 00:01 and, if no slot was found, keeps retrying every 30 minutes until 23:31 that day. Each retry is skipped if a booking request was already sent for that date (the guard file exists), so it never double-books; it also does not retry after an unconfirmed POST. Run it as one supervised PM2 process or another reliable service. The scheduled job does not need an OS cron entry.

**Important:** Only HTTP 200 is considered success. HTTP 201/204, 4xx/5xx, network errors and timeouts are **not confirmed**. Since the reservation POST may have succeeded even if its response was lost, the bot **does not automatically retry**. A single `state/YYYY-MM-DD.json` guard per date is written before POST (so 20:00 and 21:00 can never both be booked); if anything goes wrong, check the booking on the website before removing the guard. A 200 may still mean further payment or checkout steps are necessary. No response body is parsed yet.

Price is computed from court hourly_price * 1 hour + lighting feature price from `/courts/`, currently 1200 + 200 = 1400 TRY according to your example. The backend remains authoritative about final charges. Unknown or missing lighting features cause a safe failure.

**Security:** The token pasted into the conversation was exposed. Revoke it if possible, create a fresh token and keep it in `.env`. Tokens are refreshed automatically (see below). The request may also be subject to site booking rules/limits; the calendar check alone cannot guarantee booking eligibility.

## Slack notifications

Set `SLACK_WEBHOOK_URL` in `.env` (an incoming webhook; keep it secret, anyone with it can post to the channel). The bot posts:

- ✅ booking request accepted (HTTP 200), with court, date, time and price;
- ⚠️ booking request sent but not confirmed (timeout or non-200): check the website, no more attempts for that date;
- ❌ a run failed before any booking was sent (e.g. expired token, API down), with whether it will retry in 30 minutes;
- ❌ no free court at 20:00 or 21:00 by the last attempt of the day (23:31). Earlier "no slot" runs are silent;
- ℹ️ dry runs report what would have been booked, prefixed `[DRY RUN]`.

A Slack failure is logged but never stops a booking.

## Token refresh

The bot refreshes its access token the same way the website does (`POST /auth/refresh`). The refresh token **rotates on every use**, so the current pair is stored in `state/tokens.json` (mode 600); `TTA_REFRESH_TOKEN` in `.env` is only the starting seed.

Getting the seed:

1. Log in on rezervasyon.tta.com.tr in a **private/incognito window**.
2. DevTools → Application → Local Storage → copy `refreshToken` (and `accessToken`) into `.env`.
3. **Close the window without logging out.** Logging out, or that browser session refreshing with the same token, can invalidate the bot's session.

The bot refreshes when the access token is within 5 minutes of expiry, retries a GET once after a 401, and also refreshes on non-booking days to keep the session alive. If the refresh token itself is rejected you get a ❌ Slack message; repeat the steps above with a new seed (a changed `TTA_REFRESH_TOKEN` automatically replaces `state/tokens.json`) and restart the service. Don't run `npm run run` while the scheduler is running: two processes refreshing at once can invalidate each other.
