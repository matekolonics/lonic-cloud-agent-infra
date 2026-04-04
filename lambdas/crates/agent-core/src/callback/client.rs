use crate::error::AgentError;
use crate::models::registration::AgentRegistration;
use crate::models::status::StatusUpdate;

pub struct CallbackClient {
    http: reqwest::Client,
    token: String,
    callback_base_url: Option<String>,
}

impl CallbackClient {
    pub fn new(token: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            token,
            callback_base_url: None,
        }
    }

    pub fn with_base_url(token: String, base_url: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            token,
            callback_base_url: Some(base_url),
        }
    }

    pub async fn send_status(
        &self,
        callback_url: &str,
        update: &StatusUpdate,
    ) -> Result<(), AgentError> {
        let body = serde_json::to_vec(update)?;

        let mut last_err = None;
        for attempt in 0..3 {
            if attempt > 0 {
                // Exponential backoff: 100ms, 400ms
                let delay = std::time::Duration::from_millis(100 * 4u64.pow(attempt - 1));
                tokio::time::sleep(delay).await;
            }

            match self
                .http
                .post(callback_url)
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {}", self.token))
                .body(body.clone())
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => return Ok(()),
                Ok(resp) if resp.status().is_server_error() => {
                    tracing::warn!(
                        attempt,
                        status = %resp.status(),
                        "callback returned server error, retrying"
                    );
                    last_err = Some(AgentError::CallbackError(
                        resp.error_for_status().unwrap_err(),
                    ));
                }
                Ok(resp) => {
                    // Client error (4xx) — don't retry
                    return Err(AgentError::CallbackError(
                        resp.error_for_status().unwrap_err(),
                    ));
                }
                Err(e) if e.is_connect() || e.is_timeout() => {
                    tracing::warn!(attempt, error = %e, "callback request failed, retrying");
                    last_err = Some(AgentError::CallbackError(e));
                }
                Err(e) => return Err(AgentError::CallbackError(e)),
            }
        }

        Err(last_err.unwrap())
    }

    /// Register this agent with the hosted backend.
    /// Uses `callback_base_url` from the `LONIC_CALLBACK_BASE_URL` env var.
    pub async fn send_registration(
        &self,
        registration: &AgentRegistration,
    ) -> Result<(), AgentError> {
        let base_url = self.callback_base_url.as_deref().ok_or_else(|| {
            AgentError::ConfigError("LONIC_CALLBACK_BASE_URL not set, cannot register".into())
        })?;

        let url = format!("{}/agent/register", base_url.trim_end_matches('/'));
        let body = serde_json::to_vec(registration)?;

        self.http
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", self.token))
            .body(body)
            .send()
            .await?
            .error_for_status()
            .map_err(AgentError::CallbackError)?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::status::ExecutionStatus;
    use wiremock::matchers::{body_json_string, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_update() -> StatusUpdate {
        StatusUpdate {
            command_id: "cmd-test".into(),
            status: ExecutionStatus::Succeeded,
            agent_id: "agent-test".into(),
            agent_version: "0.1.0".into(),
            step: None,
            outputs: None,
            error: None,
            timestamp: chrono::Utc::now(),
        }
    }

    #[tokio::test]
    async fn sends_bearer_token_header() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/callback"))
            .and(header("Authorization", "Bearer test-token-123"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let client = CallbackClient::new("test-token-123".into());
        let url = format!("{}/callback", server.uri());
        client.send_status(&url, &test_update()).await.unwrap();
    }

    #[tokio::test]
    async fn sends_json_body() {
        let server = MockServer::start().await;
        let update = test_update();
        let expected_body = serde_json::to_string(&update).unwrap();

        Mock::given(method("POST"))
            .and(path("/callback"))
            .and(header("Content-Type", "application/json"))
            .and(body_json_string(&expected_body))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let client = CallbackClient::new("tok".into());
        let url = format!("{}/callback", server.uri());
        client.send_status(&url, &update).await.unwrap();
    }

    #[tokio::test]
    async fn returns_error_on_4xx_without_retry() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401))
            .expect(1) // exactly 1 — no retries
            .mount(&server)
            .await;

        let client = CallbackClient::new("bad-token".into());
        let url = format!("{}/callback", server.uri());
        let result = client.send_status(&url, &test_update()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn retries_on_5xx_then_succeeds() {
        let server = MockServer::start().await;

        // First two calls return 503, third succeeds
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(2)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let client = CallbackClient::new("tok".into());
        let url = format!("{}/callback", server.uri());
        client.send_status(&url, &test_update()).await.unwrap();
    }

    #[tokio::test]
    async fn send_registration_posts_to_register_endpoint() {
        use crate::models::registration::AgentRegistration;

        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/agent/register"))
            .and(header("Authorization", "Bearer reg-token"))
            .and(header("Content-Type", "application/json"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let client = CallbackClient::with_base_url("reg-token".into(), server.uri());
        let reg = AgentRegistration {
            agent_id: "agent-abc".into(),
            agent_version: "0.1.0".into(),
            region: "us-east-1".into(),
            account_id: "123456789012".into(),
            capabilities: vec!["deploy-stacks".into()],
            timestamp: chrono::Utc::now(),
        };

        client.send_registration(&reg).await.unwrap();
    }

    #[tokio::test]
    async fn send_registration_errors_without_base_url() {
        use crate::models::registration::AgentRegistration;

        let client = CallbackClient::new("tok".into());
        let reg = AgentRegistration {
            agent_id: "agent-abc".into(),
            agent_version: "0.1.0".into(),
            region: "us-east-1".into(),
            account_id: "123456789012".into(),
            capabilities: vec![],
            timestamp: chrono::Utc::now(),
        };

        let result = client.send_registration(&reg).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("LONIC_CALLBACK_BASE_URL"));
    }

    #[tokio::test]
    async fn retries_exhausted_on_5xx() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500))
            .expect(3) // initial + 2 retries
            .mount(&server)
            .await;

        let client = CallbackClient::new("tok".into());
        let url = format!("{}/callback", server.uri());
        let result = client.send_status(&url, &test_update()).await;
        assert!(result.is_err());
    }
}
