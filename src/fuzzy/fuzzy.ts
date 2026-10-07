/**
 * Fuzzy-in primitives — tolerant matching with explicit confidence and audit trails.
 * Design: docs/design/flow-dag-formalization.md §4 (fuzzy.ts) and §6.
 *
 * Backend-agnostic fuzzy-in primitives for tolerant matching with explicit confidence
 * and audit trails. These scorers originated in scheduling-bridge's Acuity
 * ServiceResolver cascade, but they are pure string/slot/field machinery and belong in
 * the reusable kit surface so every adapter can share one scoring authority.
 */

import { Context, Data, Effect, Layer } from 'effect';

/** Strategy vocabulary, identical to ServiceResolution.strategy. */
export type FuzzyStrategy = 'id-match' | 'normalized-exact' | 'token-overlap' | 'fuzzy';

/** The audit record every tolerant match produces. */
export interface FuzzyResolution<A> {
	readonly value: A;
	/** 0..1 */
	readonly confidence: number;
	readonly strategy: FuzzyStrategy;
	readonly matchedLabel: string;
	/** Policy that admitted the match. */
	readonly threshold: number;
	readonly alternates: readonly { readonly label: string; readonly confidence: number }[];
}

/** Failure: no candidate cleared the admitting threshold. */
export class FuzzyMatchError extends Data.TaggedError('FuzzyMatchError')<{
	readonly query: string;
	readonly threshold: number;
	readonly bestConfidence: number;
	readonly message: string;
}> {}

export interface FuzzyMatcher<Q, A> {
	readonly threshold: number;
	readonly match: (
		query: Q,
		candidates: readonly A[],
	) => Effect.Effect<FuzzyResolution<A>, FuzzyMatchError>;
}

export interface ServiceMatchQuery {
	readonly serviceName: string;
	readonly appointmentTypeId?: string;
}

export interface ServiceCandidate {
	readonly label: string;
	readonly ref: string;
}

export class ServiceMatcher extends Context.Service<
	ServiceMatcher,
	FuzzyMatcher<ServiceMatchQuery, ServiceCandidate>
>()('scheduling-kit/ServiceMatcher') {}

// =============================================================================
// SHARED SCORING MACHINERY
// =============================================================================

/** Normalize a string: lowercase, strip non-alphanumeric (keep spaces), collapse whitespace. */
export const normalize = (s: string): string =>
	s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

/** Tokenize: split on whitespace into lowercase words. */
const tokenize = (s: string): Set<string> =>
	new Set(normalize(s).split(' ').filter(Boolean));

/** Token overlap score: |intersection| / max(|a|, |b|). */
export const tokenOverlap = (a: string, b: string): number => {
	const setA = tokenize(a);
	const setB = tokenize(b);
	if (setA.size === 0 || setB.size === 0) return 0;

	let intersection = 0;
	for (const token of setA) {
		if (setB.has(token)) intersection++;
	}

	return intersection / Math.max(setA.size, setB.size);
};

/** Levenshtein edit distance between two strings. */
export const levenshtein = (a: string, b: string): number => {
	const m = a.length;
	const n = b.length;

	if (m === 0) return n;
	if (n === 0) return m;

	const row = Array.from({ length: n + 1 }, (_, i) => i);

	for (let i = 1; i <= m; i++) {
		let prev = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const val = Math.min(
				row[j] + 1,
				prev + 1,
				row[j - 1] + cost,
			);
			row[j - 1] = prev;
			prev = val;
		}
		row[n] = prev;
	}

	return row[n];
};

/** Fuzzy match confidence: 1 - (distance / maxLen), after normalization. */
export const fuzzyConfidence = (a: string, b: string): number => {
	const na = normalize(a);
	const nb = normalize(b);
	const maxLen = Math.max(na.length, nb.length);
	if (maxLen === 0) return 0;

	const dist = levenshtein(na, nb);
	return Math.max(0, 1 - dist / maxLen);
};

/** Cascade strategy thresholds. */
export const TOKEN_THRESHOLD = 0.6;
export const FUZZY_THRESHOLD = 0.6;

/**
 * Score one label against a query through the fuzzy-in cascade (sans id-match, which
 * needs a stable ref): normalized-exact (0.95), token-overlap (raw >= 0.6 scaled onto
 * 0.5-0.9), then fuzzy/Levenshtein (raw >= 0.6 scaled onto 0.3-0.7). Returns the best
 * admitted strategy, or a zero-confidence `fuzzy` score when nothing is admitted.
 */
export const scoreLabel = (
	query: string,
	label: string,
): { readonly strategy: FuzzyStrategy; readonly confidence: number } => {
	if (normalize(query) === normalize(label) && normalize(query).length > 0) {
		return { strategy: 'normalized-exact', confidence: 0.95 };
	}

	const overlap = tokenOverlap(query, label);
	if (overlap >= TOKEN_THRESHOLD) {
		const confidence = 0.5 + ((overlap - TOKEN_THRESHOLD) / (1 - TOKEN_THRESHOLD)) * 0.4;
		return { strategy: 'token-overlap', confidence };
	}

	const fuzzy = fuzzyConfidence(query, label);
	if (fuzzy >= FUZZY_THRESHOLD) {
		const confidence = 0.3 + ((fuzzy - FUZZY_THRESHOLD) / (1 - FUZZY_THRESHOLD)) * 0.4;
		return { strategy: 'fuzzy', confidence };
	}

	return { strategy: 'fuzzy', confidence: 0 };
};

/** Default service matcher: id-match first, then the label cascade over candidates. */
export const makeServiceMatcher = (
	threshold = 0.3,
): FuzzyMatcher<ServiceMatchQuery, ServiceCandidate> => ({
	threshold,
	match: (query, candidates) =>
		Effect.suspend(() => {
			if (query.appointmentTypeId !== undefined) {
				const byId = candidates.find((c) => c.ref === query.appointmentTypeId);
				if (byId) {
					return Effect.succeed<FuzzyResolution<ServiceCandidate>>({
						value: byId,
						confidence: 1.0,
						strategy: 'id-match',
						matchedLabel: byId.label,
						threshold,
						alternates: [],
					});
				}
			}

			const scored = candidates
				.map((candidate) => ({ candidate, score: scoreLabel(query.serviceName, candidate.label) }))
				.sort((a, b) => b.score.confidence - a.score.confidence);
			const best = scored[0];

			if (!best || best.score.confidence < threshold) {
				return Effect.fail(
					new FuzzyMatchError({
						query: query.serviceName,
						threshold,
						bestConfidence: best?.score.confidence ?? 0,
						message: `No service candidate cleared threshold ${threshold} for '${query.serviceName}'`,
					}),
				);
			}

			return Effect.succeed<FuzzyResolution<ServiceCandidate>>({
				value: best.candidate,
				confidence: best.score.confidence,
				strategy: best.score.strategy,
				matchedLabel: best.candidate.label,
				threshold,
				alternates: scored
					.slice(1)
					.map(({ candidate, score }) => ({ label: candidate.label, confidence: score.confidence })),
			});
		}),
});

/** Default ServiceMatcher layer (Layer substitution replaces test-seam overrides). */
export const ServiceMatcherLive: Layer.Layer<ServiceMatcher> = Layer.sync(ServiceMatcher, () =>
	makeServiceMatcher(),
);
