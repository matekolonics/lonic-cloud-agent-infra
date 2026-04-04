use aws_sdk_secretsmanager::Client;

use crate::error::AgentError;

pub struct SecretLoader {
    client: Client,
    secret_arn: String,
}

impl SecretLoader {
    pub fn new(client: Client, secret_arn: String) -> Self {
        Self { client, secret_arn }
    }

    pub fn from_env(config: &aws_config::SdkConfig) -> Result<Self, AgentError> {
        let secret_arn = std::env::var("LONIC_CALLBACK_TOKEN_ARN")
            .map_err(|_| AgentError::ConfigError("LONIC_CALLBACK_TOKEN_ARN not set".into()))?;
        let client = Client::new(config);
        Ok(Self::new(client, secret_arn))
    }

    pub async fn load(&self) -> Result<String, AgentError> {
        let output = self
            .client
            .get_secret_value()
            .secret_id(&self.secret_arn)
            .send()
            .await
            .map_err(|e| AgentError::AwsError(format!("failed to load secret: {e}")))?;

        output
            .secret_string()
            .map(|s| s.to_string())
            .ok_or_else(|| {
                AgentError::ConfigError("secret must be a string value".into())
            })
    }
}
