import { config } from './config.js';

/** Posts a message to the Slack webhook. Never throws: a Slack outage must not break booking. */
export async function notify(text: string): Promise<void> {
  if (!config.slackWebhookUrl) return;
  const prefix = config.dryRun ? '[DRY RUN] ' : '';
  try {
    const response = await fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: prefix + text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) console.error(`Slack notification failed (${response.status})`);
  } catch (error) {
    console.error('Slack notification failed:', error instanceof Error ? error.message : String(error));
  }
}
