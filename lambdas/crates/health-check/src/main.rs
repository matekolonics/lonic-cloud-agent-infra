use lambda_runtime::{service_fn, Error, LambdaEvent};
use serde::Deserialize;

use agent_core::models::health::HealthResponse;

/// Cached identity info loaded once at cold start.
struct AppState {
    agent_id: String,
    region: String,
    account_id: String,
}

/// Health check command — payload is minimal, just needs a commandId for traceability.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthCheckEvent {
    #[serde(default)]
    command_id: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    agent_core::observability::init_tracing();

    let aws_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .load()
        .await;

    let region = aws_config
        .region()
        .map(|r| r.to_string())
        .unwrap_or_else(|| "unknown".into());

    let sts = aws_sdk_sts::Client::new(&aws_config);
    let identity = sts
        .get_caller_identity()
        .send()
        .await
        .map_err(|e| Error::from(format!("failed to get caller identity: {e}")))?;
    let account_id = identity.account().unwrap_or("unknown").to_string();
    let agent_id = std::env::var("AGENT_ID").unwrap_or_else(|_| "unknown".into());

    tracing::info!(
        agent_version = agent_core::AGENT_VERSION,
        %agent_id,
        %region,
        %account_id,
        "health-check Lambda initialized"
    );

    let state = std::sync::Arc::new(AppState {
        agent_id,
        region,
        account_id,
    });

    lambda_runtime::run(service_fn(move |event| {
        let state = std::sync::Arc::clone(&state);
        handler(state, event)
    }))
    .await
}

async fn handler(
    state: std::sync::Arc<AppState>,
    event: LambdaEvent<HealthCheckEvent>,
) -> Result<HealthResponse, Error> {
    let (event, _context) = event.into_parts();

    if let Some(ref cmd_id) = event.command_id {
        let _span = tracing::info_span!("health_check", command_id = %cmd_id).entered();
        tracing::info!("health check requested");
    }

    Ok(HealthResponse {
        agent_id: state.agent_id.clone(),
        agent_version: agent_core::AGENT_VERSION.to_string(),
        region: state.region.clone(),
        account_id: state.account_id.clone(),
        timestamp: chrono::Utc::now(),
    })
}
