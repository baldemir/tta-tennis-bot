import 'dotenv/config';

export const config = {
  apiBase: 'https://api.rezervasyon.tta.com.tr/api/v1',
  branchId: process.env.TTA_BRANCH_ID || '2f6601ba-e223-4d52-ba83-958385d5fd69',
  accessToken: process.env.TTA_ACCESS_TOKEN ?? '',
  // Seed only: the refresh token rotates on every use; the current pair lives in state/tokens.json.
  refreshToken: process.env.TTA_REFRESH_TOKEN ?? '',
  tokenFile: 'state/tokens.json',
  firstPlayerId: process.env.TTA_FIRST_PLAYER_ID ?? '',
  secondPlayerId: process.env.TTA_SECOND_PLAYER_ID ?? '',
  dryRun: process.env.DRY_RUN !== 'false',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? '',
  timezone: 'Europe/Istanbul',
  // Daily attempts (Europe/Istanbul): 00:01, then every 30 minutes until 23:31. Later attempts only
  // run if no booking request was sent yet, e.g. when slots were not open or were all taken.
  // All attempts stay within one calendar day, so they all target the same booking date.
  attemptTimes: Array.from({ length: 48 }, (_, i) => {
    const minutes = 1 + i * 30;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }),
  daysAhead: 3,
  // Only book when the target date falls on one of these weekdays (0 = Sunday ... 6 = Saturday).
  bookingWeekdays: [2, 4], // Tuesday, Thursday
  // Tried in order; the first time with any free court is booked.
  startTimes: ['20:00', '21:00'],
  durationMinutes: 60,
  preference: 'INDOOR' as const,
};
