// Researcher hypothesis submission endpoint.
//
// Accepts a structured submission via POST, validates input, verifies
// Turnstile, rate-limits per IP, and stores the submission as a JSON file
// in the robertium repo at data/submissions/pending/{ulid}.json via the
// GitHub Contents API. Pending submissions are reviewed manually before
// they enter the discovery pipeline.

import { isValidOrcid } from '../../src/lib/orcid';

interface Env {
  TURNSTILE_SECRET_KEY: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  IP_HASH_SALT: string;
  TELEGRAM_BOT_TOKEN: string;
}

type SubmitInput = {
  drug: string;
  mediator: string;
  outcome: string;
  submitter_name: string;
  submitter_affiliation: string;
  submitter_email: string;
  submitter_orcid?: string;
  reasoning?: string;
  turnstile_token: string;
};

type ErrorCode =
  | 'validation_failed'
  | 'turnstile_failed'
  | 'storage_failed'
  | 'internal_error';

const SCHEMA_VERSION = '1.0';
const SUBMISSION_SOURCE = 'website_form_v1';
const STORAGE_MAX_ATTEMPTS = 3;

// Identity used as both committer and author on the GitHub Contents API
// PUT. Setting these explicitly (instead of letting GitHub fall back to the
// PAT owner) means the commit is treated as a third-party event, which is
// what triggers email notifications for repo watchers, including the owner.
// Side benefit: cleaner `git blame` — submissions are a distinct actor from
// Daniel's manual commits.
const SUBMISSION_BOT_NAME = 'Robertium Submissions Bot';
const SUBMISSION_BOT_EMAIL = 'submissions@robertium.com';

// Telegram notification target. Hardcoded numeric chat_id (Daniel's
// Telegram ID); the bot must be started by the user once (/start) before
// it can send messages to this chat. Token comes from the Pages secret
// TELEGRAM_BOT_TOKEN, never logged.
const TELEGRAM_ADMIN_CHAT_ID = 738922628;
const TELEGRAM_API_TIMEOUT_MS = 5000;

// ----- ULID (Crockford base32, lex-sortable) ---------------------------------
// First 10 chars = millisecond timestamp, last 16 = 80 bits of randomness.
// Inline implementation keeps the Worker bundle dependency-free.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(): string {
  let timeStr = '';
  let remainder = Date.now();
  for (let i = 0; i < 10; i++) {
    timeStr = CROCKFORD[remainder % 32] + timeStr;
    remainder = Math.floor(remainder / 32);
  }
  const random = new Uint8Array(10);
  crypto.getRandomValues(random);
  let randStr = '';
  for (let i = 0; i < 16; i++) {
    const bitPos = i * 5;
    const bytePos = bitPos >> 3;
    const bitOffset = bitPos & 7;
    const combined = ((random[bytePos] ?? 0) << 8) | (random[bytePos + 1] ?? 0);
    const value = (combined >> (11 - bitOffset)) & 0x1f;
    randStr += CROCKFORD[value];
  }
  return timeStr + randStr;
}

// ----- HTTP helpers ----------------------------------------------------------

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
} as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, string>,
): Response {
  return jsonResponse(status, { ok: false, error: code, message, ...(details ? { details } : {}) });
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64Utf8(input: string): string {
  // btoa alone breaks on non-Latin1; route through UTF-8 bytes first.
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ----- Validation ------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const HTML_INJECTION_RE = /<\/?[a-z][\s\S]*?>|javascript:|data:/i;

function sanitizeLine(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
}

function sanitizeMultiline(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.replace(CONTROL_RE, '').replace(/[\r\n]+/g, '\n').trim();
}

function rangeError(field: string, value: string, min: number, max: number): string | null {
  if (value.length < min) return `${field} is too short (min ${min} characters)`;
  if (value.length > max) return `${field} is too long (max ${max} characters)`;
  return null;
}

function unsafeError(field: string, value: string): string | null {
  return HTML_INJECTION_RE.test(value) ? `${field} contains disallowed content` : null;
}

type Validation = { ok: true; value: SubmitInput } | { ok: false; details: Record<string, string> };

function validate(raw: unknown): Validation {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, details: { _: 'Invalid request body' } };
  }
  const body = raw as Record<string, unknown>;
  const details: Record<string, string> = {};

  const lineFields: Array<[keyof SubmitInput, unknown, number, number]> = [
    ['drug', body.drug, 2, 100],
    ['mediator', body.mediator, 2, 100],
    ['outcome', body.outcome, 2, 200],
    ['submitter_name', body.submitter_name, 2, 100],
    ['submitter_affiliation', body.submitter_affiliation, 2, 200],
  ];

  const cleaned: Record<string, string> = {};
  for (const [name, raw_value, min, max] of lineFields) {
    const v = sanitizeLine(raw_value);
    cleaned[name as string] = v;
    const lenErr = rangeError(name as string, v, min, max);
    if (lenErr) { details[name as string] = lenErr; continue; }
    const safeErr = unsafeError(name as string, v);
    if (safeErr) details[name as string] = safeErr;
  }

  const email = sanitizeLine(body.submitter_email).toLowerCase();
  cleaned.submitter_email = email;
  if (!email) details.submitter_email = 'submitter_email is required';
  else if (email.length > 254) details.submitter_email = 'submitter_email is too long (max 254 characters)';
  else if (!EMAIL_RE.test(email)) details.submitter_email = 'submitter_email is not a valid email address';

  const orcidRaw = sanitizeLine(body.submitter_orcid);
  let orcid: string | undefined;
  if (orcidRaw) {
    if (!isValidOrcid(orcidRaw)) {
      details.submitter_orcid = 'submitter_orcid is not a valid ORCID (format XXXX-XXXX-XXXX-XXXX with checksum)';
    } else {
      orcid = orcidRaw;
    }
  }

  const reasoning = sanitizeMultiline(body.reasoning);
  if (reasoning.length > 2000) {
    details.reasoning = 'reasoning is too long (max 2000 characters)';
  } else if (reasoning) {
    const safeErr = unsafeError('reasoning', reasoning);
    if (safeErr) details.reasoning = safeErr;
  }

  const turnstileToken = typeof body.turnstile_token === 'string' ? body.turnstile_token : '';
  if (!turnstileToken) details.turnstile_token = 'turnstile_token is required';

  if (Object.keys(details).length > 0) return { ok: false, details };

  return {
    ok: true,
    value: {
      drug: cleaned.drug,
      mediator: cleaned.mediator,
      outcome: cleaned.outcome,
      submitter_name: cleaned.submitter_name,
      submitter_affiliation: cleaned.submitter_affiliation,
      submitter_email: cleaned.submitter_email,
      ...(orcid ? { submitter_orcid: orcid } : {}),
      ...(reasoning ? { reasoning } : {}),
      turnstile_token: turnstileToken,
    },
  };
}

// ----- Turnstile -------------------------------------------------------------

async function verifyTurnstile(token: string, ip: string, secret: string): Promise<boolean> {
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    });
    if (!resp.ok) {
      console.warn(`[submit] turnstile http ${resp.status}`);
      return false;
    }
    const result = (await resp.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (result.success !== true) {
      console.warn('[submit] turnstile rejected:', (result['error-codes'] ?? []).join(','));
    }
    return result.success === true;
  } catch (err) {
    console.error('[submit] turnstile network error:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

// ----- GitHub storage --------------------------------------------------------

type StorageResult =
  | { ok: true; submissionId: string }
  | { ok: false; reason: 'auth' | 'http' | 'network' | 'collision_retry_exhausted' };

async function storeSubmission(
  submission: Record<string, unknown>,
  env: Env,
): Promise<StorageResult> {
  const hyp = submission.hypothesis as Record<string, string>;

  for (let attempt = 0; attempt < STORAGE_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // 422 collision or 5xx — back off and (for 422) regenerate ID.
      submission.submission_id = ulid();
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
    }
    const id = submission.submission_id as string;
    const path = `data/submissions/pending/${id}.json`;
    const message = `submission(${id.slice(0, 8)}): ${hyp.drug} -> ${hyp.mediator} -> ${hyp.outcome}`;
    const content = base64Utf8(JSON.stringify(submission, null, 2) + '\n');

    let resp: Response;
    try {
      resp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
        method: 'PUT',
        headers: {
          'authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'accept': 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'robertium-submissions/1.0',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({
          message,
          content,
          branch: env.GITHUB_BRANCH,
          committer: { name: SUBMISSION_BOT_NAME, email: SUBMISSION_BOT_EMAIL },
          author: { name: SUBMISSION_BOT_NAME, email: SUBMISSION_BOT_EMAIL },
        }),
      });
    } catch (err) {
      console.error('[submit] github fetch error:', err instanceof Error ? err.message : String(err));
      return { ok: false, reason: 'network' };
    }

    if (resp.status === 201) return { ok: true, submissionId: id };
    if (resp.status === 401 || resp.status === 403) {
      const body = await resp.text().catch(() => '');
      console.error(`[submit] github auth ${resp.status}: ${body.slice(0, 300)}`);
      return { ok: false, reason: 'auth' };
    }
    if (resp.status === 422) {
      console.warn(`[submit] github 422 (collision) attempt=${attempt} id=${id}`);
      continue; // ULID collision — vanishingly rare, retry.
    }
    if (resp.status >= 500 && attempt + 1 < STORAGE_MAX_ATTEMPTS) {
      console.warn(`[submit] github ${resp.status} attempt=${attempt}, retrying`);
      continue;
    }
    const body = await resp.text().catch(() => '');
    console.error(`[submit] github http ${resp.status}: ${body.slice(0, 300)}`);
    return { ok: false, reason: 'http' };
  }
  return { ok: false, reason: 'collision_retry_exhausted' };
}

// ----- Handlers --------------------------------------------------------------

// Guard that every secret/var promised by `Env` is actually present at
// runtime. If anything is missing we fail with a structured 503 plus a
// logged list of missing names, instead of a cryptic 502 from a downstream
// undefined access. (Historical context: an unbound KV namespace used to
// trip this exact failure mode before rate limiting was removed.)
function checkEnv(env: Env): string[] {
  const missing: string[] = [];
  if (!env.TURNSTILE_SECRET_KEY) missing.push('TURNSTILE_SECRET_KEY');
  if (!env.GITHUB_TOKEN) missing.push('GITHUB_TOKEN');
  if (!env.GITHUB_REPO) missing.push('GITHUB_REPO');
  if (!env.GITHUB_BRANCH) missing.push('GITHUB_BRANCH');
  if (!env.IP_HASH_SALT) missing.push('IP_HASH_SALT');
  if (!env.TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  return missing;
}

// ----- Telegram notification -------------------------------------------------

// Telegram parse_mode=HTML accepts a small whitelist of tags; everything
// else must be entity-encoded. We use HTML rather than MarkdownV2 because
// the escape rules are simpler and our payload is plain text wrapped in
// <b>...</b>.
function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendTelegramNotification(
  env: Env,
  submission: Record<string, unknown>,
  submissionId: string,
): Promise<void> {
  const submitter = submission.submitter as Record<string, string>;
  const hyp = submission.hypothesis as Record<string, string>;
  const reasoning = (submission.reasoning as string | undefined) ?? '';

  const reviewUrl =
    `https://github.com/${env.GITHUB_REPO}/blob/${env.GITHUB_BRANCH}` +
    `/data/submissions/pending/${submissionId}.json`;

  const e = escapeTelegramHtml;
  const orcidLine = submitter.orcid ? e(submitter.orcid) : '<i>not provided</i>';
  const reasoningBlock = reasoning ? e(reasoning) : '<i>not provided</i>';

  const text = [
    '🔬 <b>New Robertium submission</b>',
    '',
    `<b>Drug:</b> ${e(hyp.drug)}`,
    `<b>Mediator:</b> ${e(hyp.mediator)}`,
    `<b>Outcome:</b> ${e(hyp.outcome)}`,
    '',
    `<b>From:</b> ${e(submitter.name)} (${e(submitter.affiliation)})`,
    `<b>Email:</b> ${e(submitter.email)}`,
    `<b>ORCID:</b> ${orcidLine}`,
    '',
    '<b>Reasoning:</b>',
    reasoningBlock,
    '',
    `<b>ID:</b> <code>${e(submissionId)}</code>`,
    `<a href="${reviewUrl}">Review on GitHub</a>`,
  ].join('\n');

  // Telegram caps text at 4096 chars. With drug/mediator/outcome limited
  // to 100-200 chars each by validate() and reasoning to 2000 chars we
  // stay well under, but guard against future schema changes.
  const truncated = text.length > 4096 ? text.slice(0, 4090) + '\n…' : text;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_API_TIMEOUT_MS);

  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_ADMIN_CHAT_ID,
          text: truncated,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      },
    );

    if (!resp.ok) {
      // Body has the error description; never log the URL — it contains
      // the bot token.
      const body = await resp.text().catch(() => '');
      console.warn(`[submit] telegram http ${resp.status}: ${body.slice(0, 300)}`);
      return;
    }
    const data = (await resp.json()) as { ok?: boolean; description?: string };
    if (!data.ok) {
      console.warn('[submit] telegram api rejected:', data.description ?? 'unknown');
    }
  } finally {
    clearTimeout(timeout);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // Wrap the entire handler so any unhandled throw becomes a structured 500
  // with a server-side log entry, instead of a bare 502 from the runtime.
  try {
    const missing = checkEnv(env);
    if (missing.length > 0) {
      console.error('[submit] missing env bindings:', missing.join(', '));
      return errorResponse(
        503,
        'internal_error',
        'Submission service is not fully configured. Please email daniel@robertium.com.',
      );
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch (err) {
      console.warn('[submit] invalid JSON body:', describeError(err));
      return errorResponse(400, 'validation_failed', 'Request body must be valid JSON');
    }

    const validation = validate(raw);
    if (!validation.ok) {
      return errorResponse(
        400,
        'validation_failed',
        'One or more fields failed validation',
        validation.details,
      );
    }
    const input = validation.value;

    const clientIp = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';

    let ipHash: string;
    try {
      ipHash = await sha256Hex(clientIp + env.IP_HASH_SALT);
    } catch (err) {
      console.error('[submit] sha256 failed:', describeError(err));
      return errorResponse(500, 'internal_error', 'Internal error hashing client identifier.');
    }

    const turnstileOk = await verifyTurnstile(
      input.turnstile_token,
      clientIp,
      env.TURNSTILE_SECRET_KEY,
    );
    if (!turnstileOk) {
      return errorResponse(403, 'turnstile_failed', 'Bot verification failed, please retry');
    }

    const submission: Record<string, unknown> = {
      schema_version: SCHEMA_VERSION,
      submission_id: ulid(),
      submitted_at: new Date().toISOString(),
      submitter: {
        name: input.submitter_name,
        affiliation: input.submitter_affiliation,
        email: input.submitter_email,
        ...(input.submitter_orcid ? { orcid: input.submitter_orcid } : {}),
      },
      hypothesis: {
        drug: input.drug,
        mediator: input.mediator,
        outcome: input.outcome,
      },
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      metadata: {
        turnstile_verified: true,
        ip_address_hash: `sha256:${ipHash}`,
        submission_source: SUBMISSION_SOURCE,
      },
      status: 'pending',
    };

    const storage = await storeSubmission(submission, env);
    if (!storage.ok) {
      console.error('[submit] storage failed:', storage.reason);
      const message =
        storage.reason === 'auth'
          ? 'Submission service is misconfigured. Please email daniel@robertium.com.'
          : 'Submission service is temporarily unavailable. Please retry in a few minutes.';
      return errorResponse(502, 'storage_failed', message);
    }

    // Notify Daniel out-of-band via Telegram. The submission is already
    // persisted in GitHub at this point, so a notification failure must
    // not surface to the user — just log and continue.
    try {
      await sendTelegramNotification(env, submission, storage.submissionId);
    } catch (err) {
      console.warn('[submit] telegram notification failed:', describeError(err));
    }

    console.log('[submit] ok:', storage.submissionId);
    return jsonResponse(200, { ok: true, submission_id: storage.submissionId });
  } catch (err) {
    console.error('[submit] unhandled exception:', describeError(err));
    return errorResponse(
      500,
      'internal_error',
      'An unexpected error occurred. Please retry shortly.',
    );
  }
};

export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'access-control-max-age': '86400' },
  });
};

export const onRequest: PagesFunction = async () => {
  // Fallback for non-POST/OPTIONS methods (smoke-test target per constraint 6:
  //   GET /api/submit should return 405).
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { 'allow': 'POST, OPTIONS' },
  });
};
