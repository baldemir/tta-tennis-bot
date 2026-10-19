import cron from 'node-cron';
import { config } from './config.js';
import { runBot } from './bot.js';

// Scheduler stays running. Fires daily at each config.attemptTimes entry, Europe/Istanbul.
// All attempts must fall on the same calendar day so they target the same booking date.
// Start this process well before midnight; keep server clock synchronized via NTP.
for (const time of config.attemptTimes) {
  const [hour, minute] = time.split(':').map(Number);
  const isLastAttempt = time === config.attemptTimes[config.attemptTimes.length - 1];
  cron.schedule(`${minute} ${hour} * * *`, () => { void runBot({ isLastAttempt }); }, {
    timezone: config.timezone,
  });
}
const times = config.attemptTimes;
console.log(`Scheduling ${times.length} TTA runs daily, ${times[0]}–${times[times.length - 1]} ${config.timezone}`);
