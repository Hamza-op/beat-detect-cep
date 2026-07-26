use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Event {
    pub time: f64,
    pub score: f32,
}
