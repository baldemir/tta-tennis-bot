import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';

// Mirrors the website: POST /auth/refresh {refresh_token} -> data.token_pair. The refresh token
// rotates on every use, so the newest pair is persisted to state/tokens.json immediately.
// The .env TTA_REFRESH_TOKEN is only a seed; it is used again only when you change it.

type Tokens = { accessToken: string; refreshToken: string; accessExpiresAt: number; seed: string };
type TokenPair = { access_token: { value: string; expires_at?: string }; refresh_token: { value: string; expires_at?: string } };

const REFRESH_MARGIN_MS = 5 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** Expiry from the JWT `exp` claim, or 0 (treat as expired) if the token is not a readable JWT. */
function jwtExpiry(token: string): number {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp;
    return Number.isFinite(exp) ? exp * 1000 : 0;
  } catch { return 0; }
}

async function loadTokens(): Promise<Tokens | undefined> {
  const seed = config.refreshToken ? hash(config.refreshToken) : '';
  let saved: Tokens | undefined;
  try { saved = JSON.parse(await readFile(config.tokenFile, 'utf8')); } catch { /* none yet */ }
  // A new refresh token in .env (re-seed after the session died) wins over the saved pair.
  if (saved && (!seed || saved.seed === seed)) return saved;
  if (config.refreshToken) return { accessToken: config.accessToken, refreshToken: config.refreshToken, accessExpiresAt: jwtExpiry(config.accessToken), seed };
  if (config.accessToken) return { accessToken: config.accessToken, refreshToken: '', accessExpiresAt: jwtExpiry(config.accessToken) || Infinity, seed: '' };
  return undefined;
}

async function saveTokens(tokens: Tokens): Promise<void> {
  await mkdir(dirname(config.tokenFile), { recursive: true });
  const tmp = `${config.tokenFile}.tmp`;
  await writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  await rename(tmp, config.tokenFile);
}

async function refresh(tokens: Tokens): Promise<Tokens> {
  if (!tokens.refreshToken) throw new Error('Access token expired and no TTA_REFRESH_TOKEN set in .env');
  const response = await fetch(`${config.apiBase}/auth/refresh`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://rezervasyon.tta.com.tr' },
    body: JSON.stringify({ refresh_token: tokens.refreshToken }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Token refresh failed (${response.status}). Log in on the website and put a new TTA_REFRESH_TOKEN in .env`);
  const pair = ((await response.json()) as { data?: { token_pair?: TokenPair } }).data?.token_pair;
  if (!pair?.access_token?.value || !pair.refresh_token?.value) throw new Error('Unexpected token refresh response');
  const expiresAt = Date.parse(pair.access_token.expires_at ?? '');
  const next: Tokens = {
    accessToken: pair.access_token.value,
    refreshToken: pair.refresh_token.value,
    accessExpiresAt: Number.isFinite(expiresAt) ? expiresAt : jwtExpiry(pair.access_token.value),
    seed: tokens.seed,
  };
  // Persist before anything else: the old refresh token is no longer valid.
  await saveTokens(next);
  console.log(`Token refreshed; access token valid until ${new Date(next.accessExpiresAt).toISOString()}`);
  return next;
}

/** Returns a usable access token, refreshing it first if it expires within 5 minutes (or `force`). */
export async function getAccessToken({ force = false } = {}): Promise<string> {
  let tokens = await loadTokens();
  if (!tokens) throw new Error('Set TTA_REFRESH_TOKEN (and optionally TTA_ACCESS_TOKEN) in .env');
  if (force || tokens.accessExpiresAt - Date.now() < REFRESH_MARGIN_MS) tokens = await refresh(tokens);
  return tokens.accessToken;
}
