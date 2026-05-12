// Configuration for the /digest discovery dashboard. Edited by hand;
// auto-regenerated content (movers, recruiting trial counts, etc.) comes
// straight from the data files at build time, so the digest refreshes on
// every site rebuild without needing this file touched.

export const DIGEST_CONFIG = {
  // How many cards to show in each ranked section.
  top_n_movers: 5,
  top_n_strong: 5,
  top_n_drugs: 5,

  // Curated case-study slugs (novel only — benchmark cases excluded so the
  // digest reads as "what's interesting", not "what we validated").
  case_studies_featured: [
    'auranofin-tdp43-als',
    'curcumin-tdp43-als',
    'ketogenic-diet-sod1-als',
    'carbamazepine-kras-pancreatic-cancer',
  ],

  // Subscription handoff (MVP: mailto, no infra). Replace with a real
  // mailing-list endpoint once subscriber count justifies it.
  subscribe_email: 'daniel@robertium.com',
  subscribe_subject: 'Subscribe to Robertium digest',
  subscribe_body:
    'Please add me to the Robertium weekly digest. Affiliation / role (optional):',
} as const;

export type DigestConfig = typeof DIGEST_CONFIG;
