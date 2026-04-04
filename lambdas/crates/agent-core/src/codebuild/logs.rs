use aws_sdk_codebuild::Client;

use crate::error::AgentError;

/// Fetches build log lines from CodeBuild for error enrichment on synth failures.
pub struct BuildLogFetcher {
    client: Client,
}

/// A simplified representation of CodeBuild build info for inclusion in error reports.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildLog {
    pub build_id: String,
    pub build_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phases: Option<Vec<BuildPhase>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logs_url: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildPhase {
    pub phase_type: String,
    pub phase_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_in_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_message: Option<String>,
}

impl BuildLogFetcher {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    /// Fetch build info for a given build ID.
    /// Returns structured build info including failed phase details.
    pub async fn fetch_build_info(&self, build_id: &str) -> Result<BuildLog, AgentError> {
        let output = self
            .client
            .batch_get_builds()
            .ids(build_id)
            .send()
            .await
            .map_err(|e| {
                AgentError::AwsError(format!("failed to get build info for {build_id}: {e}"))
            })?;

        let build = output
            .builds()
            .first()
            .ok_or_else(|| AgentError::AwsError(format!("build not found: {build_id}")))?;

        let build_status = build
            .build_status()
            .map(|s| s.as_str().to_string())
            .unwrap_or_else(|| "UNKNOWN".into());

        let phases: Vec<BuildPhase> = build
            .phases()
            .iter()
            .filter_map(|phase| {
                let phase_type = phase.phase_type()?.as_str().to_string();
                let phase_status = phase.phase_status()?.as_str().to_string();

                let context_message = phase
                    .contexts()
                    .first()
                    .and_then(|ctx| ctx.message().map(|s| s.to_string()));

                Some(BuildPhase {
                    phase_type,
                    phase_status,
                    duration_in_seconds: phase.duration_in_seconds(),
                    context_message,
                })
            })
            .collect();

        let logs_url = build
            .logs()
            .and_then(|logs| logs.deep_link().map(|s| s.to_string()));

        tracing::info!(
            build_id,
            %build_status,
            phase_count = phases.len(),
            "fetched CodeBuild build info"
        );

        Ok(BuildLog {
            build_id: build_id.to_string(),
            build_status,
            phases: if phases.is_empty() {
                None
            } else {
                Some(phases)
            },
            logs_url,
        })
    }

    /// Convenience: fetch build info and convert to a JSON value for ErrorDetail.
    pub async fn fetch_build_info_json(
        &self,
        build_id: &str,
    ) -> Result<serde_json::Value, AgentError> {
        let info = self.fetch_build_info(build_id).await?;
        serde_json::to_value(info).map_err(AgentError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_log_serializes_to_camel_case() {
        let log = BuildLog {
            build_id: "project:build-abc123".into(),
            build_status: "FAILED".into(),
            phases: Some(vec![BuildPhase {
                phase_type: "BUILD".into(),
                phase_status: "FAILED".into(),
                duration_in_seconds: Some(42),
                context_message: Some("exit status 1".into()),
            }]),
            logs_url: Some("https://console.aws.amazon.com/cloudwatch/logs".into()),
        };

        let json = serde_json::to_value(&log).unwrap();
        assert_eq!(json["buildId"], "project:build-abc123");
        assert_eq!(json["buildStatus"], "FAILED");
        assert_eq!(json["phases"][0]["phaseType"], "BUILD");
        assert_eq!(json["phases"][0]["phaseStatus"], "FAILED");
        assert_eq!(json["phases"][0]["durationInSeconds"], 42);
        assert_eq!(json["phases"][0]["contextMessage"], "exit status 1");
        assert!(json["logsUrl"].as_str().is_some());
    }

    #[test]
    fn build_log_omits_none_fields() {
        let log = BuildLog {
            build_id: "project:build-xyz".into(),
            build_status: "SUCCEEDED".into(),
            phases: None,
            logs_url: None,
        };

        let json = serde_json::to_value(&log).unwrap();
        assert!(json.get("phases").is_none());
        assert!(json.get("logsUrl").is_none());
    }

    #[test]
    fn build_phase_omits_none_fields() {
        let phase = BuildPhase {
            phase_type: "INSTALL".into(),
            phase_status: "SUCCEEDED".into(),
            duration_in_seconds: None,
            context_message: None,
        };

        let json = serde_json::to_value(&phase).unwrap();
        assert!(json.get("durationInSeconds").is_none());
        assert!(json.get("contextMessage").is_none());
    }
}
