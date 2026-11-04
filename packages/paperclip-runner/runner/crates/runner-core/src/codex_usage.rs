use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct CodexRunUsage {
    baseline: Option<BTreeMap<String, Value>>,
    latest: BTreeMap<String, Value>,
}

impl CodexRunUsage {
    pub(crate) fn new(requires_baseline: bool) -> Self {
        Self {
            baseline: (!requires_baseline).then(BTreeMap::new),
            latest: BTreeMap::new(),
        }
    }

    pub(crate) fn is_valid(&self) -> bool {
        self.baseline
            .iter()
            .flat_map(|values| values.values())
            .chain(self.latest.values())
            .all(|value| {
                value
                    .as_f64()
                    .is_some_and(|value| value.is_finite() && value >= 0.0)
            })
    }

    pub(crate) fn increases_known_usage(&self, total: &Value) -> bool {
        !self.latest.is_empty()
            && total.as_object().is_some_and(|total| {
                total.iter().any(|(key, value)| {
                    value.as_f64().is_some_and(|value| {
                        value > self.latest.get(key).and_then(Value::as_f64).unwrap_or(0.0)
                    })
                })
            })
    }

    pub(crate) fn increases_run_baseline(&self, total: &Value) -> bool {
        self.baseline.as_ref().is_some_and(|baseline| {
            total.as_object().is_some_and(|total| {
                total.iter().any(|(key, value)| {
                    value.as_f64().is_some_and(|value| {
                        value > baseline.get(key).and_then(Value::as_f64).unwrap_or(0.0)
                    })
                })
            })
        })
    }

    pub(crate) fn has_baseline(&self) -> bool {
        self.baseline.is_some()
    }

    pub(crate) fn begin_run(&mut self) {
        if self.latest.is_empty() {
            return;
        }
        self.baseline = (valid_token(self.latest.get("inputTokens"))
            && valid_token(self.latest.get("outputTokens")))
        .then(|| self.latest.clone());
    }

    pub(crate) fn observe(&mut self, total: &Value, historical: bool) -> (Value, bool) {
        let measurement: BTreeMap<String, Value> = total
            .as_object()
            .into_iter()
            .flat_map(|value| value.iter())
            .filter(|(_, value)| {
                value
                    .as_f64()
                    .is_some_and(|value| value.is_finite() && value >= 0.0)
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let complete = self.baseline.is_some()
            && (historical
                || measurement.iter().all(|(key, value)| {
                    !key.ends_with("Tokens")
                        || value.as_u64().is_some_and(|value| {
                            value >= self.latest.get(key).and_then(Value::as_u64).unwrap_or(0)
                                && value
                                    >= self
                                        .baseline
                                        .as_ref()
                                        .and_then(|baseline| baseline.get(key))
                                        .and_then(Value::as_u64)
                                        .unwrap_or(0)
                        })
                }))
            && valid_token(measurement.get("inputTokens"))
            && valid_token(measurement.get("outputTokens"))
            && measurement
                .iter()
                .all(|(key, value)| !key.ends_with("Tokens") || valid_token(Some(value)))
            && self
                .latest
                .keys()
                .all(|key| !key.ends_with("Tokens") || valid_token(measurement.get(key)));
        if historical
            && self.baseline.is_none()
            && valid_token(measurement.get("inputTokens"))
            && valid_token(measurement.get("outputTokens"))
        {
            self.baseline = Some(measurement.clone());
        }
        for (key, value) in measurement {
            if value.as_f64().unwrap()
                >= self.latest.get(&key).and_then(Value::as_f64).unwrap_or(0.0)
            {
                self.latest.insert(key, value);
            }
        }
        let delta: serde_json::Map<String, Value> = self
            .latest
            .iter()
            .map(|(key, value)| {
                let baseline = self
                    .baseline
                    .as_ref()
                    .and_then(|baseline| baseline.get(key));
                let delta = if let Some(value) = value.as_u64() {
                    json!(value.saturating_sub(baseline.and_then(Value::as_u64).unwrap_or(0)))
                } else {
                    json!((value.as_f64().unwrap()
                        - baseline.and_then(Value::as_f64).unwrap_or(0.0))
                    .max(0.0))
                };
                (key.clone(), delta)
            })
            .collect();
        (Value::Object(delta), complete)
    }
}

fn valid_token(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_u64)
        .is_some_and(|value| value <= 9_007_199_254_740_991)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_resumed_baselines_across_requests_recovery_and_attachment() {
        let mut usage = CodexRunUsage::new(true);
        usage.observe(
            &json!({"inputTokens":100,"outputTokens":10,"cachedInputTokens":20}),
            true,
        );
        let (first, complete) = usage.observe(
            &json!({"inputTokens":140,"outputTokens":16,"cachedInputTokens":25}),
            false,
        );
        assert!(complete);
        assert_eq!(first["inputTokens"], 40);
        let mut restored: CodexRunUsage =
            serde_json::from_value(serde_json::to_value(&usage).unwrap()).unwrap();
        let (second, complete) = restored.observe(
            &json!({"inputTokens":190,"outputTokens":25,"cachedInputTokens":30}),
            false,
        );
        assert!(complete);
        assert_eq!(
            second,
            json!({"inputTokens":90,"outputTokens":15,"cachedInputTokens":10})
        );
        restored.begin_run();
        let (next, complete) = restored.observe(
            &json!({"inputTokens":220,"outputTokens":29,"cachedInputTokens":32}),
            false,
        );
        assert!(complete);
        assert_eq!(
            next,
            json!({"inputTokens":30,"outputTokens":4,"cachedInputTokens":2})
        );
    }

    #[test]
    fn attachment_before_paid_work_preserves_a_proven_empty_baseline() {
        let mut usage = CodexRunUsage::new(false);
        usage.begin_run();
        let (delta, complete) = usage.observe(&json!({"inputTokens":100,"outputTokens":10}), false);
        assert!(complete);
        assert_eq!(delta, json!({"inputTokens":100,"outputTokens":10}));
        let mut unknown = CodexRunUsage::new(true);
        unknown.begin_run();
        assert!(
            !unknown
                .observe(&json!({"inputTokens":100,"outputTokens":10}), false)
                .1
        );
    }

    #[test]
    fn regressing_live_totals_remain_incomplete_without_losing_known_exposure() {
        let mut usage = CodexRunUsage::new(false);
        usage.observe(&json!({"inputTokens":100,"outputTokens":10}), false);
        let (delta, complete) = usage.observe(&json!({"inputTokens":90,"outputTokens":9}), false);
        assert!(!complete);
        assert_eq!(delta, json!({"inputTokens":100,"outputTokens":10}));
        let mut resumed = CodexRunUsage::new(true);
        resumed.observe(&json!({"inputTokens":100,"outputTokens":10}), true);
        assert!(
            !resumed
                .observe(&json!({"inputTokens":90,"outputTokens":9}), false)
                .1
        );
    }

    #[test]
    fn unknown_baselines_and_missing_counters_cannot_certify_usage() {
        let mut usage = CodexRunUsage::new(true);
        assert!(
            !usage
                .observe(&json!({"inputTokens":140,"outputTokens":16}), false)
                .1
        );
        usage.observe(&json!({"inputTokens":100,"outputTokens":10}), true);
        assert!(!usage.observe(&json!({"inputTokens":160}), false).1);
        assert!(
            usage
                .observe(&json!({"inputTokens":170,"outputTokens":20}), false)
                .1
        );
    }
}
