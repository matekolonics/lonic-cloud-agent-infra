use aws_sdk_cloudformation::Client;

use crate::error::AgentError;

/// Fetches and filters CloudFormation stack events for error enrichment.
pub struct CfnEventFetcher {
    client: Client,
}

/// A simplified CloudFormation event for inclusion in error reports.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfnEvent {
    pub timestamp: String,
    pub logical_resource_id: String,
    pub resource_type: String,
    pub resource_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_status_reason: Option<String>,
}

impl CfnEventFetcher {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    /// Fetch recent failure events for a given stack.
    /// Returns events with FAILED/ROLLBACK statuses, most recent first.
    pub async fn fetch_failure_events(
        &self,
        stack_name: &str,
        max_events: usize,
    ) -> Result<Vec<CfnEvent>, AgentError> {
        let output = self
            .client
            .describe_stack_events()
            .stack_name(stack_name)
            .send()
            .await
            .map_err(|e| {
                AgentError::AwsError(format!(
                    "failed to describe stack events for {stack_name}: {e}"
                ))
            })?;

        let events: Vec<CfnEvent> = output
            .stack_events()
            .iter()
            .filter(|e| {
                e.resource_status()
                    .map(|s| {
                        let s = s.as_str();
                        s.contains("FAILED") || s.contains("ROLLBACK")
                    })
                    .unwrap_or(false)
            })
            .take(max_events)
            .map(|e| CfnEvent {
                timestamp: e
                    .timestamp()
                    .map(|t| t.to_string())
                    .unwrap_or_default(),
                logical_resource_id: e
                    .logical_resource_id()
                    .unwrap_or("unknown")
                    .to_string(),
                resource_type: e
                    .resource_type()
                    .unwrap_or("unknown")
                    .to_string(),
                resource_status: e
                    .resource_status()
                    .map(|s| s.as_str().to_string())
                    .unwrap_or_default(),
                resource_status_reason: e.resource_status_reason().map(|s| s.to_string()),
            })
            .collect();

        tracing::info!(
            stack_name,
            event_count = events.len(),
            "fetched CloudFormation failure events"
        );

        Ok(events)
    }

    /// Convenience: fetch failure events and convert to JSON values for ErrorDetail.cfn_events.
    pub async fn fetch_failure_events_json(
        &self,
        stack_name: &str,
        max_events: usize,
    ) -> Result<Vec<serde_json::Value>, AgentError> {
        let events = self.fetch_failure_events(stack_name, max_events).await?;
        events
            .into_iter()
            .map(|e| serde_json::to_value(e).map_err(AgentError::from))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cfn_event_serializes_to_camel_case() {
        let event = CfnEvent {
            timestamp: "2026-04-04T10:00:00Z".into(),
            logical_resource_id: "MyService".into(),
            resource_type: "AWS::ECS::Service".into(),
            resource_status: "CREATE_FAILED".into(),
            resource_status_reason: Some("Service already exists".into()),
        };

        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["logicalResourceId"], "MyService");
        assert_eq!(json["resourceType"], "AWS::ECS::Service");
        assert_eq!(json["resourceStatus"], "CREATE_FAILED");
        assert_eq!(json["resourceStatusReason"], "Service already exists");
    }

    #[test]
    fn cfn_event_omits_none_reason() {
        let event = CfnEvent {
            timestamp: "2026-04-04T10:00:00Z".into(),
            logical_resource_id: "MyBucket".into(),
            resource_type: "AWS::S3::Bucket".into(),
            resource_status: "DELETE_FAILED".into(),
            resource_status_reason: None,
        };

        let json = serde_json::to_value(&event).unwrap();
        assert!(json.get("resourceStatusReason").is_none());
    }
}
