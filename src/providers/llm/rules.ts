// RulesLlmProvider — the DEFAULT LlmProvider (spec §9, §8.3). Zero external
// calls, zero cost, fully deterministic. Spec's own framing: "El sistema
// tiene que funcionar y tener sentido con el provider de reglas; el LLM es
// mejora, no dependencia" — this file is the load-bearing default, not a
// fallback stub. OllamaLlmProvider (LLM_PROVIDER='ollama' in config.ts) is
// explicitly out of this phase's scope and remains unimplemented.
//
// This is infrastructure (src/providers/**), not under the core-layer
// ESLint boundary — but note it has NO infrastructure imports at all (no
// network, no filesystem): everything it produces comes from its inputs.

import type {
  EnrichmentRequest,
  EnrichmentResult,
  LlmProvider,
  RationaleRequest,
} from '../../domain/ports.js';
import type { ScoreBreakdown } from '../../domain/entities.js';

// ---------------------------------------------------------------------------
// rationale() — 2-3 sentences built PURELY from `req.breakdown`, `req.company`,
// and `req.thesis` (spec: "lo arma con plantillas a partir del breakdown").
// Deterministic: identical inputs always produce identical output text,
// verified by unit tests. Never claims to be an LLM (no "I think", "in my
// analysis", or similar framing) — it is straightforwardly template-driven,
// and is a load-bearing default this system must function well with alone.
// ---------------------------------------------------------------------------

const COMPONENT_LABELS = {
  semantic: 'semantic fit with the thesis',
  momentum: 'recent momentum',
  keywords: 'keyword alignment',
  recency: 'how recently the company was first seen',
} as const;

type ComponentKey = keyof typeof COMPONENT_LABELS;
const COMPONENT_KEYS: readonly ComponentKey[] = ['semantic', 'momentum', 'keywords', 'recency'];

/**
 * Recomputes the final 0-100 score straight from `breakdown` — the same
 * formula as scoring/scorer.ts's combineWeightedScore, deliberately
 * duplicated (not imported: see scorer.ts's own cross-module-duplication
 * note; scoring/ and providers/ are different layers with no import path
 * between them either way). Recomputing here rather than requiring the
 * caller to also pass the final score is the point of "audit purely from
 * breakdown" — this function's output is fully self-consistent using only
 * what RationaleRequest actually contains.
 */
function scoreFromBreakdown(breakdown: ScoreBreakdown): number {
  return Math.round(
    100 *
      COMPONENT_KEYS.reduce((sum, key) => sum + breakdown[key].weight * breakdown[key].value, 0),
  );
}

/**
 * Names the component(s) whose WEIGHTED CONTRIBUTION (weight * value — the
 * actual points contributed to the 0-100 score, not the raw [0,1] value) is
 * largest. A second component is named alongside the top one only when its
 * contribution is within 25% of the top's, so "driven mostly by X and Y" is
 * only said when both genuinely mattered comparably.
 */
function dominantComponents(breakdown: ScoreBreakdown): readonly ComponentKey[] {
  const contributions = COMPONENT_KEYS.map((key) => ({
    key,
    contribution: breakdown[key].weight * breakdown[key].value,
  })).sort((a, b) => b.contribution - a.contribution);

  const top = contributions[0]!;
  if (top.contribution <= 0) return [];
  const second = contributions[1];
  if (second && second.contribution > 0 && second.contribution >= top.contribution * 0.75) {
    return [top.key, second.key];
  }
  return [top.key];
}

function componentContributionsSentence(breakdown: ScoreBreakdown): string {
  const parts = COMPONENT_KEYS.map((key) => {
    const points = Math.round(100 * breakdown[key].weight * breakdown[key].value);
    return `${key} ${points}`;
  });
  return `Component contributions (points out of 100): ${parts.join(', ')}.`;
}

function extrasSentence(req: RationaleRequest): string | undefined {
  const clauses: string[] = [];

  const context: string[] = [];
  if (req.company.sector) context.push(`sector ${req.company.sector}`);
  if (req.company.estimatedStage && req.company.estimatedStage !== 'unknown') {
    context.push(`stage ${req.company.estimatedStage}`);
  }
  if (context.length > 0) clauses.push(`known context — ${context.join(', ')}`);

  if (req.company.flags.includes('merge_incierto')) {
    clauses.push(
      `merged from multiple source records with only moderate confidence ('merge_incierto')`,
    );
  }

  if (clauses.length === 0) return undefined;
  const joined = clauses.join('; ');
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

function buildRationale(req: RationaleRequest): string {
  const { company, breakdown, thesis } = req;

  if (breakdown.failedHardFilter) {
    const sentences = [
      `${company.canonicalName} scored 0 against the "${thesis.name}" thesis: ${breakdown.failedHardFilter}.`,
      'This is a hard-filter disqualification, so no weighted component score applies.',
    ];
    const extras = extrasSentence(req);
    if (extras) sentences.push(extras);
    return sentences.join(' ');
  }

  const score = scoreFromBreakdown(breakdown);
  const dominant = dominantComponents(breakdown);
  const topText =
    dominant.length === 0
      ? 'no single component stood out — every component contributed only modestly'
      : `driven mostly by ${dominant.map((key) => COMPONENT_LABELS[key]).join(' and ')}`;

  const sentences = [
    `${company.canonicalName} scores ${score}/100 against the "${thesis.name}" thesis, ${topText}.`,
    componentContributionsSentence(breakdown),
  ];
  const extras = extrasSentence(req);
  if (extras) sentences.push(extras);

  return sentences.join(' ');
}

// ---------------------------------------------------------------------------
// enrich() — deliberately a LOW-EFFORT, HONEST implementation. Per this
// phase's own scope note: enrichment (spec §3) is a real but secondary
// concern, and the interesting work of this project lives in resolution
// (Phase 4) and scoring (this file's sibling, scorer.ts) — not here. This
// method does a shallow keyword-in-text sector guess and a truncated
// one-liner, and is explicit about low confidence rather than fabricating
// a specific sector/stage it has no real basis for. estimatedStage is
// never set: EnrichmentRequest carries only name/description/signals, none
// of which give a defensible basis for guessing investment stage without
// inventing a heuristic this phase has no evidence for.
// ---------------------------------------------------------------------------

const ONE_LINER_MAX_LENGTH = 140;

// Ordered [needle, sector] pairs — first match wins. Deliberately small and
// coarse; a real sector taxonomy is out of this phase's scope, and a wrong
// guess here only affects `confidence: 0.3` (low) output, never a hard
// filter or a silently-trusted field.
const SECTOR_KEYWORD_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['fintech', 'fintech'],
  ['devtool', 'devtools'],
  ['developer tool', 'devtools'],
  ['health', 'healthtech'],
  ['biotech', 'biotech'],
  ['climate', 'climate'],
  ['security', 'security'],
  ['machine learning', 'ai'],
  ['artificial intelligence', 'ai'],
  [' ai ', 'ai'],
  ['blockchain', 'crypto'],
  ['crypto', 'crypto'],
  ['marketplace', 'marketplace'],
  ['e-commerce', 'ecommerce'],
  ['ecommerce', 'ecommerce'],
  ['saas', 'saas'],
];

function guessSector(text: string): string | undefined {
  const padded = ` ${text} `;
  const hit = SECTOR_KEYWORD_HINTS.find(([needle]) => padded.includes(needle));
  return hit?.[1];
}

function truncateToOneLiner(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length <= ONE_LINER_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, ONE_LINER_MAX_LENGTH - 1).trimEnd()}…`;
}

async function enrich(req: EnrichmentRequest): Promise<EnrichmentResult> {
  const text = `${req.name} ${req.description ?? ''}`.toLowerCase();
  const sector = guessSector(text);
  const oneLiner = req.description ? truncateToOneLiner(req.description) : undefined;

  return {
    // exactOptionalPropertyTypes: omit rather than assign undefined,
    // matching the conditional-spread idiom already used in
    // src/db/repository.ts's loadCompany().
    ...(sector ? { sector } : {}),
    ...(oneLiner ? { oneLiner } : {}),
    confidence: sector ? 0.3 : 0,
  };
}

export function createRulesLlmProvider(): LlmProvider {
  return {
    id: 'rules',
    enrich,
    rationale: (req) => Promise.resolve(buildRationale(req)),
  };
}
