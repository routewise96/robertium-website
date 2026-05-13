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
  RATE_LIMIT_KV: KVNamespace;
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
  | 'rate_limited'
  | 'storage_failed'
  | 'internal_error';

const SCHEMA_VERSION = '1.0';
const SUBMISSION_SOURCE = 'website_form_v1';
const RATE_LIMIT_TTL_SECONDS = 86_400;
const STORAGE_MAX_ATTEMPTS = 3;

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
    if (!resp.ok) return false;
    const result = (await resp.json()) as { success?: boolean };
    return result.success === true;
  } catch {
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
          'user-agent': 'robertium-submissions/1.0',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({ message, content, branch: env.GITHUB_BRANCH }),
      });
    } catch {
      return { ok: false, reason: 'network' };
    }

    if (resp.status === 201) return { ok: true, submissionId: id };
    if (resp.status === 401 || resp.status === 403) return { ok: false, reason: 'auth' };
    if (resp.status === 422) continue; // ULID collision — vanishingly rare, retry.
    if (resp.status >= 500 && attempt + 1 < STORAGE_MAX_ATTEMPTS) continue;
    return { ok: false, reason: 'http' };
  }
  return { ok: false, reason: 'collision_retry_exhausted' };
}

// ----- Handlers --------------------------------------------------------------

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, 'validation_failed', 'Request body must be valid JSON');
  }

  const validation = validate(raw);
  if (!validation.ok) {
    return errorResponse(400, 'validation_failed', 'One or more fields failed validation', validation.details);
  }
  const input = validation.value;

  const clientIp = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  const ipHash = await sha256Hex(clientIp + env.IP_HASH_SALT);
  const rateKey = `rate:${ipHash}`;

  if (await env.RATE_LIMIT_KV.get(rateKey)) {
    return errorResponse(
      429,
      'rate_limited',
      'A submission from this network was already received in the last 24 hours',
    );
  }

  const turnstileOk = await verifyTurnstile(input.turnstile_token, clientIp, env.TURNSTILE_SECRET_KEY);
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
    const message =
      storage.reason === 'auth'
        ? 'Submission service is misconfigured. Please email daniel@robertium.com.'
        : 'Submission service is temporarily unavailable. Please retry in a few minutes.';
    return errorResponse(502, 'storage_failed', message);
  }

  await env.RATE_LIMIT_KV.put(rateKey, storage.submissionId, {
    expirationTtl: RATE_LIMIT_TTL_SECONDS,
  });

  return jsonResponse(200, { ok: true, submission_id: storage.submissionId });
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
