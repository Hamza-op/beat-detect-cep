use serde::Serialize;
use std::error::Error;
use std::fmt;

/// A detected beat or onset candidate.
///
/// JSON representation:
/// `{"time": 1.25, "score": 0.82}`
///
/// Fields remain public for compatibility with existing detector code.
/// Direct construction or mutation bypasses validation; call `validate()`
/// before accepting external events or serializing unchecked values.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct Event {
    /// Timestamp in seconds.
    ///
    /// The detector initially produces analysis-relative timestamps.
    /// The CLI adds the decoded source offset before emitting JSON.
    /// Valid values are finite and nonnegative.
    pub time: f64,

    /// Relative musical salience in the inclusive range 0..=1.
    ///
    /// This is not a calibrated probability that the event is a beat.
    pub score: f32,
}

/// Explains why an event failed validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventValidationError {
    NonFiniteTime,
    NegativeTime,
    NonFiniteScore,
    ScoreOutOfRange,
}

impl fmt::Display for EventValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NonFiniteTime => "event time must be finite",
            Self::NegativeTime => "event time must be nonnegative",
            Self::NonFiniteScore => "event score must be finite",
            Self::ScoreOutOfRange => "event score must be between 0 and 1 inclusive",
        })
    }
}

impl Error for EventValidationError {}

impl Event {
    /// Constructs an event without silently clamping invalid values.
    ///
    /// Precision is preserved. Rounding belongs at the output boundary.
    pub fn try_new(time: f64, score: f32) -> Result<Self, EventValidationError> {
        let event = Self { time, score };
        event.validate()?;

        // Normalize negative zero for predictable JSON output.
        Ok(Self {
            time: if time == 0.0 { 0.0 } else { time },
            score: if score == 0.0 { 0.0 } else { score },
        })
    }

    /// Validates an event created or modified through its public fields.
    pub fn validate(&self) -> Result<(), EventValidationError> {
        if !self.time.is_finite() {
            return Err(EventValidationError::NonFiniteTime);
        }

        if self.time < 0.0 {
            return Err(EventValidationError::NegativeTime);
        }

        if !self.score.is_finite() {
            return Err(EventValidationError::NonFiniteScore);
        }

        if !(0.0..=1.0).contains(&self.score) {
            return Err(EventValidationError::ScoreOutOfRange);
        }

        Ok(())
    }

    /// Returns whether both fields satisfy the event contract.
    pub fn is_valid(&self) -> bool {
        self.validate().is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_values_and_score_boundaries() {
        for score in [0.0, 0.5, 1.0] {
            let event = Event::try_new(1.25, score).unwrap();

            assert_eq!(event.time, 1.25);
            assert_eq!(event.score, score);
            assert!(event.is_valid());
        }

        assert!(Event::try_new(0.0, 0.0).is_ok());
    }

    #[test]
    fn preserves_timestamp_precision() {
        let time = 123.456_789_123;
        assert_eq!(Event::try_new(time, 0.75).unwrap().time, time);
    }

    #[test]
    fn rejects_invalid_times() {
        for time in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(
                Event::try_new(time, 0.5),
                Err(EventValidationError::NonFiniteTime)
            );
        }

        assert_eq!(
            Event::try_new(-0.001, 0.5),
            Err(EventValidationError::NegativeTime)
        );
    }

    #[test]
    fn rejects_invalid_scores() {
        for score in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(
                Event::try_new(1.0, score),
                Err(EventValidationError::NonFiniteScore)
            );
        }

        for score in [-0.01, 1.01] {
            assert_eq!(
                Event::try_new(1.0, score),
                Err(EventValidationError::ScoreOutOfRange)
            );
        }
    }

    #[test]
    fn normalizes_negative_zero() {
        let event = Event::try_new(-0.0, -0.0).unwrap();

        assert!(!event.time.is_sign_negative());
        assert!(!event.score.is_sign_negative());
    }

    #[test]
    fn validates_direct_construction_and_mutation() {
        let mut event = Event {
            time: 1.0,
            score: 0.5,
        };

        assert!(event.is_valid());

        event.score = 2.0;

        assert_eq!(event.validate(), Err(EventValidationError::ScoreOutOfRange));
    }

    #[test]
    fn preserves_the_existing_json_schema() {
        let event = Event::try_new(1.25, 0.5).unwrap();
        let json = serde_json::to_string(&event).unwrap();

        assert_eq!(json, r#"{"time":1.25,"score":0.5}"#);
    }
}
