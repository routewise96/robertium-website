// Client-side submission form controller.
//
// Mirrors the validation surface enforced server-side in
// functions/api/submit.ts so users see fast inline feedback. Server remains
// the source of truth — any error returned from the API is shown verbatim
// so a passed client check that fails server-side still surfaces clearly.

import { isValidOrcid } from '../lib/orcid';

interface TurnstileWindow extends Window {
  turnstile?: {
    reset: (widget?: string | HTMLElement) => void;
    getResponse: (widget?: string | HTMLElement) => string | undefined;
  };
  onTurnstileSuccess?: (token: string) => void;
}

type FieldName =
  | 'drug'
  | 'mediator'
  | 'outcome'
  | 'submitter_name'
  | 'submitter_affiliation'
  | 'submitter_email'
  | 'submitter_orcid'
  | 'reasoning'
  | 'turnstile_token';

interface SubmitOkResponse {
  ok: true;
  submission_id: string;
}

interface SubmitErrResponse {
  ok: false;
  error: string;
  message: string;
  details?: Record<string, string>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTML_INJECTION_RE = /<\/?[a-z][\s\S]*?>|javascript:|data:/i;

const LINE_LIMITS: Record<string, { min: number; max: number }> = {
  drug: { min: 2, max: 100 },
  mediator: { min: 2, max: 100 },
  outcome: { min: 2, max: 200 },
  submitter_name: { min: 2, max: 100 },
  submitter_affiliation: { min: 2, max: 200 },
};

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function cleanMultiline(value: string): string {
  return value.replace(/[\r\n]+/g, '\n').trim();
}

function validateLine(name: string, raw: string): string | null {
  const value = clean(raw);
  const limit = LINE_LIMITS[name];
  if (!limit) return null;
  if (value.length < limit.min) return `${name} is too short (min ${limit.min} characters)`;
  if (value.length > limit.max) return `${name} is too long (max ${limit.max} characters)`;
  if (HTML_INJECTION_RE.test(value)) return `${name} contains disallowed content`;
  return null;
}

function validateEmail(raw: string): string | null {
  const value = clean(raw).toLowerCase();
  if (!value) return 'submitter_email is required';
  if (value.length > 254) return 'submitter_email is too long (max 254 characters)';
  if (!EMAIL_RE.test(value)) return 'submitter_email is not a valid email address';
  return null;
}

function validateOrcid(raw: string): string | null {
  const value = clean(raw);
  if (!value) return null; // optional
  if (!isValidOrcid(value)) {
    return 'submitter_orcid is not a valid ORCID (format XXXX-XXXX-XXXX-XXXX with checksum)';
  }
  return null;
}

function validateReasoning(raw: string): string | null {
  const value = cleanMultiline(raw);
  if (value.length > 2000) return 'reasoning is too long (max 2000 characters)';
  if (value && HTML_INJECTION_RE.test(value)) return 'reasoning contains disallowed content';
  return null;
}

function showError(form: HTMLFormElement, field: string, message: string | null): void {
  const target = form.querySelector<HTMLElement>(`[data-error-for="${field}"]`);
  if (target) target.textContent = message ?? '';
  const input = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${field}"]`);
  if (input) {
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function clearAllErrors(form: HTMLFormElement): void {
  form.querySelectorAll<HTMLElement>('[data-error-for]').forEach((el) => (el.textContent = ''));
  form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[aria-invalid="true"]').forEach((el) =>
    el.removeAttribute('aria-invalid'),
  );
}

function setStatus(form: HTMLFormElement, text: string, kind: '' | 'submitting' | 'error' = ''): void {
  const status = form.querySelector<HTMLElement>('#sf-status');
  if (!status) return;
  status.textContent = text;
  if (kind) status.dataset.status = kind;
  else delete status.dataset.status;
}

function setSubmitting(form: HTMLFormElement, submitting: boolean): void {
  const btn = form.querySelector<HTMLButtonElement>('#sf-submit');
  if (btn) btn.disabled = submitting;
}

function showSuccess(form: HTMLFormElement, submissionId: string): void {
  const success = document.getElementById('submission-success');
  const idEl = document.getElementById('sf-success-id');
  if (idEl) idEl.textContent = submissionId;
  if (success) success.removeAttribute('hidden');
  form.hidden = true;
  if (success) success.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clientValidate(form: HTMLFormElement): Record<string, string> {
  const data = new FormData(form);
  const errors: Record<string, string> = {};

  for (const name of Object.keys(LINE_LIMITS)) {
    const err = validateLine(name, String(data.get(name) ?? ''));
    if (err) errors[name] = err;
  }
  const emailErr = validateEmail(String(data.get('submitter_email') ?? ''));
  if (emailErr) errors.submitter_email = emailErr;
  const orcidErr = validateOrcid(String(data.get('submitter_orcid') ?? ''));
  if (orcidErr) errors.submitter_orcid = orcidErr;
  const reasonErr = validateReasoning(String(data.get('reasoning') ?? ''));
  if (reasonErr) errors.reasoning = reasonErr;

  return errors;
}

function getTurnstileToken(form: HTMLFormElement): string {
  const w = window as TurnstileWindow;
  const widget = form.querySelector<HTMLElement>('.cf-turnstile') ?? undefined;
  if (w.turnstile && widget) {
    return w.turnstile.getResponse(widget) ?? '';
  }
  const hidden = form.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
  return hidden?.value ?? '';
}

function resetTurnstile(form: HTMLFormElement): void {
  const w = window as TurnstileWindow;
  const widget = form.querySelector<HTMLElement>('.cf-turnstile') ?? undefined;
  if (w.turnstile && widget) w.turnstile.reset(widget);
}

function buildPayload(form: HTMLFormElement, turnstileToken: string): Record<string, string> {
  const data = new FormData(form);
  const payload: Record<string, string> = {
    drug: clean(String(data.get('drug') ?? '')),
    mediator: clean(String(data.get('mediator') ?? '')),
    outcome: clean(String(data.get('outcome') ?? '')),
    submitter_name: clean(String(data.get('submitter_name') ?? '')),
    submitter_affiliation: clean(String(data.get('submitter_affiliation') ?? '')),
    submitter_email: clean(String(data.get('submitter_email') ?? '')).toLowerCase(),
    turnstile_token: turnstileToken,
  };
  const orcid = clean(String(data.get('submitter_orcid') ?? ''));
  if (orcid) payload.submitter_orcid = orcid;
  const reasoning = cleanMultiline(String(data.get('reasoning') ?? ''));
  if (reasoning) payload.reasoning = reasoning;
  return payload;
}

export function initSubmissionForm(): void {
  const form = document.getElementById('submission-form') as HTMLFormElement | null;
  if (!form) return;

  // Per-field inline validation on blur — fast feedback without nagging.
  for (const name of [
    ...Object.keys(LINE_LIMITS),
    'submitter_email',
    'submitter_orcid',
    'reasoning',
  ] as FieldName[]) {
    const input = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
    if (!input) continue;
    input.addEventListener('blur', () => {
      const value = input.value;
      let err: string | null = null;
      if (name === 'submitter_email') err = validateEmail(value);
      else if (name === 'submitter_orcid') err = validateOrcid(value);
      else if (name === 'reasoning') err = validateReasoning(value);
      else err = validateLine(name, value);
      showError(form, name, err);
    });
    input.addEventListener('input', () => {
      // Clear error as soon as user starts editing — re-checks on blur.
      showError(form, name, null);
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearAllErrors(form);

    const clientErrors = clientValidate(form);
    if (Object.keys(clientErrors).length > 0) {
      for (const [field, message] of Object.entries(clientErrors)) {
        showError(form, field, message);
      }
      const firstErr = form.querySelector<HTMLElement>('[aria-invalid="true"]');
      firstErr?.focus();
      return;
    }

    const turnstileToken = getTurnstileToken(form);
    if (!turnstileToken) {
      showError(form, 'turnstile_token', 'Please complete the bot verification challenge above');
      return;
    }

    setSubmitting(form, true);
    setStatus(form, 'Submitting…', 'submitting');

    let resp: Response;
    try {
      resp = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildPayload(form, turnstileToken)),
      });
    } catch {
      setSubmitting(form, false);
      setStatus(form, '', '');
      showError(form, '_', 'Network error — please retry');
      resetTurnstile(form);
      return;
    }

    let result: SubmitOkResponse | SubmitErrResponse;
    try {
      result = (await resp.json()) as SubmitOkResponse | SubmitErrResponse;
    } catch {
      setSubmitting(form, false);
      setStatus(form, '', 'error');
      showError(form, '_', 'Unexpected server response — please retry');
      resetTurnstile(form);
      return;
    }

    if (result.ok) {
      setStatus(form, '', '');
      showSuccess(form, result.submission_id);
      return;
    }

    setSubmitting(form, false);
    setStatus(form, '', 'error');

    if (result.error === 'validation_failed' && result.details) {
      for (const [field, message] of Object.entries(result.details)) {
        showError(form, field, message);
      }
      const firstErr = form.querySelector<HTMLElement>('[aria-invalid="true"]');
      firstErr?.focus();
    } else if (result.error === 'turnstile_failed') {
      showError(form, 'turnstile_token', result.message);
      resetTurnstile(form);
    } else if (result.error === 'rate_limited') {
      showError(form, '_', result.message);
    } else if (result.error === 'storage_failed') {
      showError(
        form,
        '_',
        `${result.message} If the problem persists, email daniel@robertium.com directly.`,
      );
      resetTurnstile(form);
    } else {
      showError(form, '_', result.message || 'Unexpected error — please retry');
      resetTurnstile(form);
    }
  });

  // Turnstile callback wired via data-callback on the widget.
  (window as TurnstileWindow).onTurnstileSuccess = () => {
    showError(form, 'turnstile_token', null);
  };
}
