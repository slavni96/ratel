//! The one ordering every score sort and best-pick in the crate goes through.
//!
//! `a.partial_cmp(&b).unwrap_or(Equal)` is not a total order once a NaN is
//! present: the NaN compares equal to every value while those values do not
//! compare equal to each other. Since Rust 1.81 `sort_by` may panic when it
//! detects that, and when it does not, the order it leaves is unspecified, so
//! the same query could rank differently between runs. A NaN reaches a score
//! from an embedding vector that carries one (dense, hybrid, reranking, usage
//! clusters). A custom ranking function's scores and a vendor's probabilities
//! are cleaned before they are sorted, and the registries refuse NaN BM25
//! params, but every sort still has to hold if a NaN slips through.
//!
//! [`cmp_asc`] is a total order in which NaN sits below every other value,
//! `-inf` included, so a NaN is always the worst score: last in a best-first
//! sort ([`cmp_desc`]) and never the pick of a `max_by` ([`cmp_asc`]). For two
//! scores that are not NaN it answers exactly what `partial_cmp` does (`0.0`
//! and `-0.0` stay equal), so a ranking without a NaN does not move. Equal
//! scores compare `Equal`, so every caller keeps its own tie-break.

use std::cmp::Ordering;

/// Scores worst to best: ascending, with NaN below every other value and equal
/// to any other NaN. The comparator for `max_by`, which then never picks a NaN
/// over a real score.
pub(crate) fn cmp_asc(a: f32, b: f32) -> Ordering {
    match a.partial_cmp(&b) {
        Some(order) => order,
        // At least one side is NaN: the NaN side is the lower one, and two
        // NaNs tie (whatever their sign or payload).
        None => b.is_nan().cmp(&a.is_nan()),
    }
}

/// Scores best to worst: descending, with NaN after every other value. The
/// comparator for a best-first `sort_by`; chain the caller's tie-break with
/// `then_with`.
pub(crate) fn cmp_desc(a: f32, b: f32) -> Ordering {
    cmp_asc(b, a)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic Fisher-Yates shuffle (xorshift), so a failure replays.
    fn shuffle<T>(items: &mut [T], seed: u64) {
        let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        for i in (1..items.len()).rev() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let j = (state % (i as u64 + 1)) as usize;
            items.swap(i, j);
        }
    }

    /// Every awkward value at once: NaN of both signs, both infinities, both
    /// zeros, ties, and ordinary scores. 40 entries, so the standard sort runs
    /// its full algorithm rather than only the insertion sort it uses for very
    /// small inputs.
    fn awkward_scores() -> Vec<(String, f32)> {
        let specials = [
            f32::NAN,
            -f32::NAN,
            f32::NAN,
            f32::INFINITY,
            f32::NEG_INFINITY,
            0.0,
            -0.0,
            0.5,
            0.5,
            0.5,
            1.0,
            -1.0,
        ];
        let ordinary = (0..28).map(|i| (i as f32 * 0.37).sin());
        specials
            .into_iter()
            .chain(ordinary)
            .enumerate()
            .map(|(i, s)| (format!("id{i:02}"), s))
            .collect()
    }

    fn best_first(items: &mut [(String, f32)]) {
        items.sort_by(|a, b| cmp_desc(a.1, b.1).then_with(|| a.0.cmp(&b.0)));
    }

    #[test]
    fn nan_is_the_lowest_score_and_equal_to_any_other_nan() {
        assert_eq!(cmp_asc(f32::NAN, f32::NEG_INFINITY), Ordering::Less);
        assert_eq!(cmp_asc(f32::NEG_INFINITY, f32::NAN), Ordering::Greater);
        assert_eq!(cmp_asc(f32::NAN, f32::NAN), Ordering::Equal);
        assert_eq!(cmp_asc(-f32::NAN, f32::NAN), Ordering::Equal);
        assert_eq!(cmp_desc(f32::NAN, 1.0), Ordering::Greater);
        assert_eq!(cmp_desc(1.0, f32::NAN), Ordering::Less);
    }

    #[test]
    fn scores_without_nan_compare_exactly_as_partial_cmp() {
        let values = [
            f32::NEG_INFINITY,
            -1.0,
            -0.0,
            0.0,
            f32::MIN_POSITIVE,
            0.5,
            1.0,
            f32::INFINITY,
        ];
        for a in values {
            for b in values {
                assert_eq!(Some(cmp_asc(a, b)), a.partial_cmp(&b), "{a} vs {b}");
                assert_eq!(Some(cmp_desc(a, b)), b.partial_cmp(&a), "{a} vs {b}");
            }
        }
    }

    #[test]
    fn a_shuffled_mix_sorts_to_one_order_with_nan_last() {
        let mut reference = awkward_scores();
        best_first(&mut reference);
        let order: Vec<&str> = reference.iter().map(|(id, _)| id.as_str()).collect();

        let nans = reference.iter().filter(|(_, s)| s.is_nan()).count();
        assert_eq!(nans, 3);
        let (head, tail) = reference.split_at(reference.len() - nans);
        assert!(tail.iter().all(|(_, s)| s.is_nan()), "NaN last: {order:?}");
        assert!(
            head.windows(2).all(|w| w[0].1 >= w[1].1),
            "real scores best-first: {order:?}"
        );
        assert_eq!(head[0].1, f32::INFINITY);
        assert_eq!(head[head.len() - 1].1, f32::NEG_INFINITY);

        for seed in 0..200 {
            let mut shuffled = awkward_scores();
            shuffle(&mut shuffled, seed);
            best_first(&mut shuffled);
            let got: Vec<&str> = shuffled.iter().map(|(id, _)| id.as_str()).collect();
            assert_eq!(got, order, "seed {seed}");
        }
    }

    #[test]
    fn max_by_never_picks_a_nan_over_a_real_score() {
        for seed in 0..50 {
            let mut items = awkward_scores();
            shuffle(&mut items, seed);
            let best = items
                .iter()
                .max_by(|a, b| cmp_asc(a.1, b.1).then_with(|| b.0.cmp(&a.0)))
                .map(|(id, s)| (id.clone(), *s));
            assert_eq!(
                best,
                Some(("id03".to_string(), f32::INFINITY)),
                "seed {seed}"
            );
        }
    }
}
