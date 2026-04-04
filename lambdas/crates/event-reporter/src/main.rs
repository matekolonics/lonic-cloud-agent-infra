use std::sync::Arc;

use aws_sdk_sfn::Client as SfnClient;
use lambda_runtime::{service_fn, Error, LambdaEvent};
use serde::Deserialize;

use agent_core::callback::CallbackClient;
use agent_core::cfn::CfnEventFetcher;
use agent_core::codebuild::BuildLogFetcher;
use agent_core::models::status::{ErrorDetail, ExecutionStatus, StatusUpdate};
use agent_core::secrets::SecretLoader;

struct AppState {
    agent_id: String,
    callback: CallbackClient,
    sfn: SfnClient,
    cfn_events: CfnEventFetcher,
    build_logs: BuildLogFetcher,
}

/// Event shape sent by Step Functions via a Task state with `.waitForTaskToken`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskCallbackEvent {
    task_token: String,
    command_id: String,
    callback_url: String,
    status: String,
    #[serde(default)]
    step: Option<String>,
    #[serde(default)]
    outputs: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<String>,
    /// Stack name to fetch failure events from when status is FAILED.
    #[serde(default)]
    stack_name: Option<String>,
    /// CodeBuild build ID to fetch logs from when a synth/build step fails.
    #[serde(default)]
    build_id: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    agent_core::observability::init_tracing();

    let aws_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .load()
        .await;
    let agent_id = std::env::var("AGENT_ID").unwrap_or_else(|_| "unknown".into());
    let loader = SecretLoader::from_env(&aws_config)?;
    let token = loader.load().await?;

    tracing::info!(%agent_id, "event-reporter Lambda initialized");

    let state = Arc::new(AppState {
        agent_id,
        callback: CallbackClient::new(token),
        sfn: SfnClient::new(&aws_config),
        cfn_events: CfnEventFetcher::new(aws_sdk_cloudformation::Client::new(&aws_config)),
        build_logs: BuildLogFetcher::new(aws_sdk_codebuild::Client::new(&aws_config)),
    });

    lambda_runtime::run(service_fn(move |event| {
        let state = Arc::clone(&state);
        handler(state, event)
    }))
    .await
}

async fn handler(
    state: Arc<AppState>,
    event: LambdaEvent<TaskCallbackEvent>,
) -> Result<(), Error> {
    let (event, _context) = event.into_parts();
    let command_id = event.command_id.clone();
    let _span = tracing::info_span!("handle_event", %command_id).entered();

    let execution_status = parse_status(&event.status);

    // Enrich errors with CloudFormation events and/or CodeBuild logs
    let error_detail = match (&execution_status, &event.error) {
        (ExecutionStatus::Failed | ExecutionStatus::TimedOut, Some(msg)) => {
            let cfn_events = if let Some(ref stack_name) = event.stack_name {
                match state.cfn_events.fetch_failure_events_json(stack_name, 10).await {
                    Ok(events) if !events.is_empty() => Some(events),
                    Ok(_) => None,
                    Err(e) => {
                        tracing::warn!(error = %e, %stack_name, "failed to fetch CFN events for enrichment");
                        None
                    }
                }
            } else {
                None
            };

            let build_log = if let Some(ref build_id) = event.build_id {
                match state.build_logs.fetch_build_info_json(build_id).await {
                    Ok(info) => Some(info),
                    Err(e) => {
                        tracing::warn!(error = %e, %build_id, "failed to fetch build logs for enrichment");
                        None
                    }
                }
            } else {
                None
            };

            Some(ErrorDetail {
                message: msg.clone(),
                cfn_events,
                build_log,
            })
        }
        (_, Some(msg)) => Some(ErrorDetail {
            message: msg.clone(),
            cfn_events: None,
            build_log: None,
        }),
        _ => None,
    };

    let status_update = StatusUpdate {
        command_id: event.command_id.clone(),
        status: execution_status.clone(),
        agent_id: state.agent_id.clone(),
        agent_version: agent_core::AGENT_VERSION.to_string(),
        step: event.step,
        outputs: event.outputs,
        error: error_detail,
        timestamp: chrono::Utc::now(),
    };

    // POST status to the hosted backend
    let callback_result = state
        .callback
        .send_status(&event.callback_url, &status_update)
        .await;

    if let Err(e) = &callback_result {
        tracing::error!(error = %e, "failed to send status callback");
    }

    // Report back to Step Functions
    match execution_status {
        ExecutionStatus::Failed | ExecutionStatus::TimedOut => {
            state
                .sfn
                .send_task_failure()
                .task_token(&event.task_token)
                .error("ExecutionFailed")
                .cause(
                    status_update
                        .error
                        .as_ref()
                        .map(|e| e.message.as_str())
                        .unwrap_or("unknown error"),
                )
                .send()
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "failed to send task failure");
                    Error::from(e.to_string())
                })?;
        }
        _ => {
            let output =
                serde_json::to_string(&status_update).unwrap_or_else(|_| "{}".to_string());
            state
                .sfn
                .send_task_success()
                .task_token(&event.task_token)
                .output(output)
                .send()
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "failed to send task success");
                    Error::from(e.to_string())
                })?;
        }
    }

    // Propagate callback error after SFN reporting
    callback_result?;

    tracing::info!("status reported successfully");
    Ok(())
}

fn parse_status(s: &str) -> ExecutionStatus {
    match s.to_uppercase().as_str() {
        "PENDING" => ExecutionStatus::Pending,
        "IN_PROGRESS" => ExecutionStatus::InProgress,
        "SUCCEEDED" => ExecutionStatus::Succeeded,
        "FAILED" => ExecutionStatus::Failed,
        "TIMED_OUT" => ExecutionStatus::TimedOut,
        _ => {
            tracing::warn!(status = s, "unknown execution status, defaulting to IN_PROGRESS");
            ExecutionStatus::InProgress
        }
    }
}
