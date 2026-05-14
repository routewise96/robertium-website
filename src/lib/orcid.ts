// ORCID identifier validation.
//
// ORCIDs are 16-character strings in the format XXXX-XXXX-XXXX-XXXX where
// the final character is an ISO 7064 MOD 11-2 check digit (0-9 or X).
// Spec: https://support.orcid.org/hc/en-us/articles/360006897674

export const ORCID_REGEX = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

export function isValidOrcid(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (!ORCID_REGEX.test(value)) return false;
  const digits = value.replace(/-/g, '');
  return checksum(digits.slice(0, 15)) === digits[15];
}

function checksum(base15: string): string {
  let total = 0;
  for (const ch of base15) {
    total = (total + Number(ch)) * 2;
  }
  const remainder = total % 11;
  const result = (12 - remainder) % 11;
  return result === 10 ? 'X' : String(result);
}
