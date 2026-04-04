use thiserror::Error;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("invalid command: {0}")]
    InvalidCommand(#[from] serde_json::Error),

    #[error("callback request failed: {0}")]
    CallbackError(#[from] reqwest::Error),

    #[error("AWS SDK error: {0}")]
    AwsError(String),

    #[error("configuration error: {0}")]
    ConfigError(String),
}
