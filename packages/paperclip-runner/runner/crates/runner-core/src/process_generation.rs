//! Provider lifetime identity. Retained small ordinals keep their exact JSON;
//! exhausting that namespace switches permanently to equality-only UUIDs.
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uuid::Uuid;

pub const LEGACY_PROCESS_GENERATION_MAX: u64 = 9_007_199_254_740_991;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessGeneration {
    Legacy(u64),
    Opaque(Uuid),
}
impl Default for ProcessGeneration {
    fn default() -> Self {
        Self::Legacy(0)
    }
}
impl From<u64> for ProcessGeneration {
    fn from(value: u64) -> Self {
        Self::Legacy(value)
    }
}
impl PartialEq<u64> for ProcessGeneration {
    fn eq(&self, value: &u64) -> bool {
        matches!(self, Self::Legacy(n) if n == value)
    }
}
impl ProcessGeneration {
    pub fn next(self) -> Option<Self> {
        if let Self::Legacy(n) = self {
            if n < LEGACY_PROCESS_GENERATION_MAX {
                return Some(Self::Legacy(n + 1));
            }
        }
        for _ in 0..32 {
            let next = Self::Opaque(Uuid::new_v4());
            if next != self {
                return Some(next);
            }
        }
        None
    }
    pub fn opaque(self) -> bool {
        matches!(self, Self::Opaque(_))
    }
    pub fn is_successor_of(self, previous: Self) -> bool {
        match (previous, self) {
            (Self::Legacy(a), Self::Legacy(b)) => a < LEGACY_PROCESS_GENERATION_MAX && b == a + 1,
            (Self::Legacy(a), Self::Opaque(_)) => a >= LEGACY_PROCESS_GENERATION_MAX,
            (Self::Opaque(a), Self::Opaque(b)) => a != b,
            _ => false,
        }
    }
    /// Retained state used ordinal ordering as an additional corruption check.
    /// An opaque lifetime is never ordered against another opaque lifetime;
    /// completion authority can intentionally belong to an older process.
    pub fn rejects_completed(self, completed: Self) -> bool {
        match (self, completed) {
            (Self::Legacy(a), Self::Legacy(b)) => b > a,
            (Self::Legacy(_), Self::Opaque(_)) => true,
            _ => false,
        }
    }
}
impl Serialize for ProcessGeneration {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Legacy(n) => serializer.serialize_u64(*n),
            Self::Opaque(id) => serializer.serialize_str(&format!("p:{id}")),
        }
    }
}
impl<'de> Deserialize<'de> for ProcessGeneration {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Legacy(u64),
            Opaque(String),
        }
        match Wire::deserialize(deserializer)? {
            Wire::Legacy(n) if n <= LEGACY_PROCESS_GENERATION_MAX => Ok(Self::Legacy(n)),
            Wire::Legacy(_) => Err(serde::de::Error::custom(
                "legacy provider process generation exceeds the safe integer boundary",
            )),
            Wire::Opaque(s) => {
                if let Some(id) = s.strip_prefix("p:").and_then(|s| Uuid::parse_str(s).ok()) {
                    if id.get_version_num() == 4
                        && id.get_variant() == uuid::Variant::RFC4122
                        && s == format!("p:{id}")
                    {
                        return Ok(Self::Opaque(id));
                    }
                }
                Err(serde::de::Error::custom(
                    "invalid provider process generation",
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opaque_lifetimes_preserve_exact_legacy_bytes_and_never_downgrade() {
        let old = ProcessGeneration::from(LEGACY_PROCESS_GENERATION_MAX);
        assert_eq!(
            serde_json::to_string(&old).unwrap(),
            LEGACY_PROCESS_GENERATION_MAX.to_string()
        );
        let first = old.next().unwrap();
        let second = first.next().unwrap();
        assert!(first.opaque() && second.opaque());
        assert_ne!(first, second);
        assert!(first.is_successor_of(old));
        assert!(second.is_successor_of(first));
        assert!(!old.is_successor_of(second));
        assert!(!first.is_successor_of(first));
        for generation in [ProcessGeneration::default(), old, first, second] {
            assert_eq!(
                serde_json::from_str::<ProcessGeneration>(
                    &serde_json::to_string(&generation).unwrap()
                )
                .unwrap(),
                generation
            );
        }
        assert!(old.rejects_completed(first));
        assert!(!second.rejects_completed(first));
        for invalid in [
            "\"p:bad\"",
            "\"p:00000000-0000-0000-0000-000000000000\"",
            "-1",
            "1.5",
        ] {
            assert!(serde_json::from_str::<ProcessGeneration>(invalid).is_err());
        }
    }

    #[test]
    fn legacy_wire_rejects_values_above_the_javascript_safe_integer_boundary() {
        let max = LEGACY_PROCESS_GENERATION_MAX.to_string();
        assert_eq!(
            serde_json::from_str::<ProcessGeneration>(&max).unwrap(),
            ProcessGeneration::Legacy(LEGACY_PROCESS_GENERATION_MAX)
        );
        assert_eq!(
            serde_json::to_string(&ProcessGeneration::Legacy(LEGACY_PROCESS_GENERATION_MAX))
                .unwrap(),
            max
        );
        assert!(serde_json::from_str::<ProcessGeneration>("9007199254740992").is_err());
        assert!(serde_json::from_str::<ProcessGeneration>("18446744073709551615").is_err());

        // Defensive in-memory conversion can still advance an old oversized
        // value without wrapping; persisted/wire values above the boundary are
        // rejected because JavaScript cannot represent them exactly.
        let oversized_legacy = ProcessGeneration::from(LEGACY_PROCESS_GENERATION_MAX + 1);
        let successor = oversized_legacy.next().unwrap();
        assert!(successor.opaque());
        assert!(successor.is_successor_of(oversized_legacy));
    }
}
