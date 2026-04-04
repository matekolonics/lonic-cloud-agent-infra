pub mod callback;
pub mod cfn;
pub mod codebuild;
pub mod error;
pub mod models;
pub mod observability;
pub mod secrets;

/// Agent version, embedded at compile time from workspace Cargo.toml.
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
