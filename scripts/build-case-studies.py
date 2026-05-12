#!/usr/bin/env python3
"""One-off script to build src/data/case-studies/*.json from Robertium Postgres.

Pulls 5 featured hypotheses (3 novel + 2 benchmark validation hits) with their
AB/BC evidence (PMIDs, titles, years), plus 2-3 related hypotheses sharing
drug or mediator from public/data/hypotheses.json.

Biological-narrative fields are left as TODO_* placeholders for Daniel to fill —
this script does not write any interpretive text.

Usage:
    python3 scripts/build-case-studies.py

Requires the robertium-postgres Docker container to be running.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "src" / "data" / "case-studies"
CATALOG_PATH = ROOT / "public" / "data" / "hypotheses.json"

# (slug, hypothesis_id, section)
CASES: list[tuple[str, int, str]] = [
    ("auranofin-tdp43-als", 37636, "novel"),
    ("carbamazepine-kras-pancreatic-cancer", 7049, "novel"),
    ("curcumin-tdp43-als", 3772, "novel"),
    ("ketogenic-diet-sod1-als", 2091, "novel"),
    ("ketamine-nmda-chronic-pain", 5385, "benchmark"),
    ("fingolimod-hmgb1-als", 23443, "benchmark"),
]

# Hardcoded external links per entity (matched on the raw DB name).
# Drugs link to Wikipedia / DrugBank / ClinicalTrials.gov; mediators to
# Wikipedia / UniProt; outcomes to Wikipedia / MeSH.
EXTERNAL_LINKS: dict[str, dict[str, dict[str, str]]] = {
    "drugs": {
        "Auranofin": {
            "wikipedia": "https://en.wikipedia.org/wiki/Auranofin",
            "drugbank": "https://go.drugbank.com/drugs/DB00995",
            "clinicaltrials": "https://clinicaltrials.gov/search?intr=Auranofin",
        },
        "carbamazepine": {
            "wikipedia": "https://en.wikipedia.org/wiki/Carbamazepine",
            "drugbank": "https://go.drugbank.com/drugs/DB00564",
            "clinicaltrials": "https://clinicaltrials.gov/search?intr=carbamazepine",
        },
        "curcumin": {
            "wikipedia": "https://en.wikipedia.org/wiki/Curcumin",
            "drugbank": "https://go.drugbank.com/drugs/DB11672",
            "clinicaltrials": "https://clinicaltrials.gov/search?intr=curcumin",
        },
        "Ketogenic diet": {
            "wikipedia": "https://en.wikipedia.org/wiki/Ketogenic_diet",
            "clinicaltrials": "https://clinicaltrials.gov/search?intr=ketogenic+diet",
        },
        "ketamine": {
            "wikipedia": "https://en.wikipedia.org/wiki/Ketamine",
            "drugbank": "https://go.drugbank.com/drugs/DB01221",
            "clinicaltrials": "https://clinicaltrials.gov/search?intr=ketamine",
        },
        "Fingolimod": {
            "wikipedia": "https://en.wikipedia.org/wiki/Fingolimod",
            "drugbank": "https://go.drugbank.com/drugs/DB08868",
            "clinicaltrials": "https://clinicaltrials.gov/search?intr=Fingolimod",
        },
    },
    "mediators": {
        "TDP-43": {
            "wikipedia": "https://en.wikipedia.org/wiki/TARDBP",
            "uniprot": "https://www.uniprot.org/uniprotkb/Q13148",
        },
        "KRAS": {
            "wikipedia": "https://en.wikipedia.org/wiki/KRAS",
            "uniprot": "https://www.uniprot.org/uniprotkb/P01116",
        },
        "Sod1": {
            "wikipedia": "https://en.wikipedia.org/wiki/Superoxide_dismutase",
            "uniprot": "https://www.uniprot.org/uniprotkb/P00441",
        },
        "NMDA receptor": {
            "wikipedia": "https://en.wikipedia.org/wiki/NMDA_receptor",
            "uniprot": "https://www.uniprot.org/uniprotkb?query=NMDA+receptor",
        },
        "HMGB1": {
            "wikipedia": "https://en.wikipedia.org/wiki/HMGB1",
            "uniprot": "https://www.uniprot.org/uniprotkb/P09429",
        },
    },
    "outcomes": {
        "ALS": {
            "wikipedia": "https://en.wikipedia.org/wiki/Amyotrophic_lateral_sclerosis",
            "mesh": "https://meshb.nlm.nih.gov/record/ui?ui=D000690",
        },
        "pancreatic ductal adenocarcinoma": {
            "wikipedia": "https://en.wikipedia.org/wiki/Pancreatic_cancer",
            "mesh": "https://meshb.nlm.nih.gov/record/ui?ui=D021441",
        },
        "pain": {
            "wikipedia": "https://en.wikipedia.org/wiki/Pain",
            "mesh": "https://meshb.nlm.nih.gov/record/ui?ui=D010146",
        },
    },
}

# Standard limitations & disclaimer paragraph in English. Daniel may swap in
# a custom Russian (then translated) version per case study later by editing
# the JSON directly without re-running this script.
LIMITATIONS_PARAGRAPH = (
    "This hypothesis was generated algorithmically through cross-domain "
    "literature analysis and has not been experimentally validated. Treat "
    "it as a starting point for further investigation, not a therapeutic "
    "recommendation. For established knowledge about each entity, refer to "
    "the authoritative sources linked above (Wikipedia, DrugBank, UniProt, "
    "MeSH)."
)


def psql_json(sql: str) -> Any:
    """Run a SQL query inside the robertium-postgres container and return JSON."""
    wrapped = f"SELECT json_agg(row_to_json(t)) FROM ({sql}) t"
    cmd = [
        "docker",
        "exec",
        "robertium-postgres",
        "psql",
        "-U",
        "robertium",
        "-d",
        "robertium",
        "-At",
        "-c",
        wrapped,
    ]
    out = subprocess.check_output(cmd, text=True).strip()
    return json.loads(out) if out else []


def fetch_hypothesis(hyp_id: int) -> dict:
    rows = psql_json(
        f"""
        SELECT id, drug, drug_type, drug_domain, drug_canonical,
               mediator, mediator_type, mediator_canonical,
               outcome, outcome_type, outcome_domain, outcome_canonical,
               a_to_b_predicate, b_to_c_predicate,
               a_to_b_work_ids, b_to_c_work_ids,
               a_to_b_evidence_count, b_to_c_evidence_count, direct_a_to_c_count,
               outreach_score, outreach_quality, outreach_reason,
               clinical_trial_status, clinical_trial_nct_ids,
               literature_status, hypothesis_type
        FROM repurposing_hypotheses
        WHERE id = {hyp_id}
        """
    )
    if not rows:
        raise SystemExit(f"hypothesis id={hyp_id} not found")
    return rows[0]


def _sql_quote(s: str) -> str:
    """Escape single quotes for safe interpolation in psql -c literals."""
    return s.replace("'", "''")


def _norm_aliases(*names: str | None) -> list[str]:
    """Return the unique non-empty lowercased forms of the given names.
    Used as the alias set for matching entity names against
    claims.subject_normalized / claims.object_normalized."""
    seen: list[str] = []
    for n in names:
        if not n:
            continue
        v = n.strip().lower()
        if v and v not in seen:
            seen.append(v)
    return seen


def fetch_leg_evidence(
    work_ids: list[int],
    anchor_aliases: list[str],
    other_aliases: list[str],
    limit: int = 50,
) -> list[dict]:
    """Fetch enriched evidence rows for one leg (AB or BC).

    `anchor_aliases` is the shared endpoint (= mediator for both legs);
    `other_aliases` is the leg's outer endpoint (= drug for AB, outcome for BC).
    Each accepts multiple normalized forms (e.g. ALS canonical vs abbreviation)
    because claims.subject_normalized / object_normalized vary in granularity.

    For each work, picks the most-relevant claim via two tiers:
      tier 1 — claim relates anchor AND other (in either direction);
      tier 2 — claim mentions anchor on at least one side.
    Works with no anchor mention are dropped (rare; the pipeline curates
    work_ids by anchor presence).
    Returns rows ordered newest year first.
    """
    if not work_ids or not anchor_aliases:
        return []
    ids_csv = ",".join(str(w) for w in work_ids[:limit])
    anchor_list = ",".join(f"'{_sql_quote(a)}'" for a in anchor_aliases)
    other_list = ",".join(f"'{_sql_quote(o)}'" for o in other_aliases) or "''"
    rows = psql_json(
        f"""
        WITH cand AS (
            SELECT
                w.id AS work_id, w.pmid, w.title, w.doi,
                w.publication_year AS year,
                c.subject, c.predicate, c.object,
                c.context AS claim_text, c.confidence,
                er.started_at AS extracted_at,
                CASE
                    WHEN ((c.subject_normalized IN ({anchor_list})
                            AND c.object_normalized IN ({other_list}))
                       OR (c.subject_normalized IN ({other_list})
                            AND c.object_normalized IN ({anchor_list})))
                    THEN 1
                    WHEN c.subject_normalized IN ({anchor_list})
                      OR c.object_normalized IN ({anchor_list})
                    THEN 2
                    ELSE 3
                END AS match_tier
            FROM works w
            JOIN claims c ON c.work_id = w.id
            LEFT JOIN extraction_runs er ON er.id = c.extraction_run_id
            WHERE w.id IN ({ids_csv})
        )
        SELECT DISTINCT ON (work_id)
            pmid, title, doi, year,
            subject, predicate, object, claim_text, confidence, extracted_at,
            match_tier
        FROM cand
        WHERE match_tier <= 2
        ORDER BY work_id, match_tier ASC, confidence DESC
        """
    )
    out = []
    for r in rows or []:
        r.pop("match_tier", None)
        out.append(r)
    return sorted(
        out,
        key=lambda r: (r.get("year") if r.get("year") is not None else -1),
        reverse=True,
    )


def load_catalog() -> list[dict]:
    return json.loads(CATALOG_PATH.read_text())["hypotheses"]


def find_related(
    catalog: list[dict], drug_canonical: str, mediator_canonical: str, exclude_id: int, max_n: int = 3
) -> list[dict]:
    """Find 2-3 catalog hypotheses sharing drug or mediator, ordered by score desc."""
    drug_l = (drug_canonical or "").lower()
    med_l = (mediator_canonical or "").lower()
    out = []
    for h in catalog:
        if h["id"] == exclude_id:
            continue
        h_drug = (h.get("drug_canonical") or h.get("drug") or "").lower()
        h_med = (h.get("mediator_canonical") or h.get("mediator") or "").lower()
        if h_drug == drug_l or h_med == med_l:
            out.append(
                {
                    "id": h["id"],
                    "drug": h["drug"],
                    "mediator": h["mediator"],
                    "outcome": h["outcome"],
                    "score": h.get("outreach_score"),
                    "shared": "drug" if h_drug == drug_l else "mediator",
                }
            )
    out.sort(key=lambda r: r["score"] or 0, reverse=True)
    return out[:max_n]


def build_case(slug: str, hyp_id: int, section: str, catalog: list[dict]) -> dict:
    h = fetch_hypothesis(hyp_id)
    drug_aliases = _norm_aliases(h.get("drug_canonical"), h.get("drug"))
    mediator_aliases = _norm_aliases(h.get("mediator_canonical"), h.get("mediator"))
    outcome_aliases = _norm_aliases(h.get("outcome_canonical"), h.get("outcome"))
    ab_evidence = fetch_leg_evidence(
        h.get("a_to_b_work_ids") or [],
        anchor_aliases=mediator_aliases,
        other_aliases=drug_aliases,
        limit=50,
    )
    bc_evidence = fetch_leg_evidence(
        h.get("b_to_c_work_ids") or [],
        anchor_aliases=mediator_aliases,
        other_aliases=outcome_aliases,
        limit=50,
    )
    related = find_related(
        catalog,
        h.get("drug_canonical") or h["drug"],
        h.get("mediator_canonical") or h["mediator"],
        hyp_id,
        max_n=3,
    )

    return {
        "slug": slug,
        "hypothesis_id": hyp_id,
        "section": section,
        "title": f'{h["drug"]} → {h["mediator"]} → {h["outcome"]}',
        "drug": {
            "name": h["drug"],
            "canonical": h.get("drug_canonical"),
            "type": h.get("drug_type"),
            "domain": h.get("drug_domain"),
            "external_links": EXTERNAL_LINKS["drugs"].get(h["drug"], {}),
            "TODO_common_name": "TODO Daniel: brand/common names if applicable",
            "TODO_original_indication": "TODO Daniel: what disease/use was this drug originally developed for",
        },
        "mediator": {
            "name": h["mediator"],
            "canonical": h.get("mediator_canonical"),
            "type": h.get("mediator_type"),
            "external_links": EXTERNAL_LINKS["mediators"].get(h["mediator"], {}),
            "TODO_description_short": "TODO Daniel: 1-line description of what this molecule/protein does biologically",
        },
        "outcome": {
            "name": h["outcome"],
            "canonical": h.get("outcome_canonical"),
            "type": h.get("outcome_type"),
            "domain": h.get("outcome_domain"),
            "external_links": EXTERNAL_LINKS["outcomes"].get(h["outcome"], {}),
            "TODO_full_name": "TODO Daniel: full disease name if abbreviation",
        },
        "metrics": {
            "outreach_score": h.get("outreach_score"),
            "outreach_quality": h.get("outreach_quality"),
            "outreach_reason": h.get("outreach_reason"),
            "ab_count": h.get("a_to_b_evidence_count"),
            "bc_count": h.get("b_to_c_evidence_count"),
            "direct_evidence_count": h.get("direct_a_to_c_count"),
            "domain_source": h.get("drug_domain"),
            "domain_target": h.get("outcome_domain"),
            "predicate_ab": h.get("a_to_b_predicate"),
            "predicate_bc": h.get("b_to_c_predicate"),
            "literature_status": h.get("literature_status"),
            "clinical_trial_status": h.get("clinical_trial_status"),
            "clinical_trial_nct_ids": h.get("clinical_trial_nct_ids") or [],
        },
        "evidence": {
            "ab_claims": ab_evidence,
            "bc_claims": bc_evidence,
        },
        "biological_context": {
            "TODO_drug_action_summary": "TODO Daniel: 1-2 sentences on how the drug normally works",
            "TODO_mediator_role": "TODO Daniel: 1-2 sentences on mediator's known role in the outcome disease",
            "TODO_novelty_argument": "TODO Daniel: why this drug-disease combination is novel and worth investigating",
            "TODO_limitations": "TODO Daniel: honest assessment of what could be wrong with this hypothesis",
        },
        "benchmark_context": (
            {
                "TODO_why_benchmark": "TODO Daniel: explain why this is a benchmark validation hit, not a novel surfacing",
                "TODO_what_it_validates": "TODO Daniel: what aspect of the pipeline this hit confirms",
            }
            if section == "benchmark"
            else None
        ),
        "limitations_paragraph": LIMITATIONS_PARAGRAPH,
        "related_hypotheses": related,
    }


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    catalog = load_catalog()
    for slug, hyp_id, section in CASES:
        case = build_case(slug, hyp_id, section, catalog)
        out_path = DATA_DIR / f"{slug}.json"
        out_path.write_text(json.dumps(case, indent=2, ensure_ascii=False) + "\n")
        n_ab = len(case["evidence"]["ab_claims"])
        n_bc = len(case["evidence"]["bc_claims"])
        n_rel = len(case["related_hypotheses"])
        print(f"  {slug}: ab={n_ab} bc={n_bc} related={n_rel} -> {out_path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
