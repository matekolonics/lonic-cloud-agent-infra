use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusUpdate {
    pub command_id: String,
    pub status: ExecutionStatus,
    pub agent_id: String,
    pub agent_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outputs: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorDetail>,
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExecutionStatus {
    Pending,
    InProgress,
    Succeeded,
    Failed,
    TimedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetail {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cfn_events: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_log: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn serialize_status_update_omits_none_fields() {
        let update = StatusUpdate {
            command_id: "cmd-1".into(),
            status: ExecutionStatus::InProgress,
            agent_id: "agent-test".into(),
            agent_version: "0.1.0".into(),
            step: Some("deploying stack AppStack (1/2)".into()),
            outputs: None,
            error: None,
            timestamp: chrono::Utc.with_ymd_and_hms(2026, 4, 3, 14, 30, 0).unwrap(),
        };

        let json = serde_json::to_value(&update).unwrap();
        assert_eq!(json["commandId"], "cmd-1");
        assert_eq!(json["status"], "IN_PROGRESS");
        assert_eq!(json["agentId"], "agent-test");
        assert_eq!(json["agentVersion"], "0.1.0");
        assert_eq!(json["step"], "deploying stack AppStack (1/2)");
        assert!(json.get("outputs").is_none());
        assert!(json.get("error").is_none());
        assert!(json.get("timestamp").is_some());
    }

    #[test]
    fn serialize_status_update_with_error() {
        let update = StatusUpdate {
            command_id: "cmd-2".into(),
            status: ExecutionStatus::Failed,
            agent_id: "agent-test".into(),
            agent_version: "0.1.0".into(),
            step: None,
            outputs: None,
            error: Some(ErrorDetail {
                message: "stack creation failed".into(),
                cfn_events: Some(vec![serde_json::json!({
                    "resourceStatus": "CREATE_FAILED",
                    "resourceType": "AWS::ECS::Service"
                })]),
                build_log: None,
            }),
            timestamp: chrono::Utc.with_ymd_and_hms(2026, 4, 3, 14, 32, 0).unwrap(),
        };

        let json = serde_json::to_value(&update).unwrap();
        assert_eq!(json["status"], "FAILED");
        assert_eq!(json["error"]["message"], "stack creation failed");
        assert_eq!(json["error"]["cfnEvents"][0]["resourceStatus"], "CREATE_FAILED");
    }

    #[test]
    fn deserialize_status_update_roundtrip() {
        let update = StatusUpdate {
            command_id: "cmd-3".into(),
            status: ExecutionStatus::Succeeded,
            agent_id: "agent-test".into(),
            agent_version: "0.1.0".into(),
            step: None,
            outputs: Some(serde_json::json!({
                "stacks": [{ "name": "AppStack", "status": "CREATE_COMPLETE" }]
            })),
            error: None,
            timestamp: chrono::Utc.with_ymd_and_hms(2026, 4, 3, 15, 0, 0).unwrap(),
        };

        let json_str = serde_json::to_string(&update).unwrap();
        let deserialized: StatusUpdate = serde_json::from_str(&json_str).unwrap();
        assert_eq!(deserialized.command_id, "cmd-3");
        assert_eq!(deserialized.status, ExecutionStatus::Succeeded);
        assert!(deserialized.outputs.is_some());
    }

    #[test]
    fn execution_status_roundtrip_all_variants() {
        let variants = [
            (ExecutionStatus::Pending, "PENDING"),
            (ExecutionStatus::InProgress, "IN_PROGRESS"),
            (ExecutionStatus::Succeeded, "SUCCEEDED"),
            (ExecutionStatus::Failed, "FAILED"),
            (ExecutionStatus::TimedOut, "TIMED_OUT"),
        ];

        for (variant, expected_str) in variants {
            let json = serde_json::to_value(&variant).unwrap();
            assert_eq!(json, expected_str);

            let deserialized: ExecutionStatus = serde_json::from_value(json).unwrap();
            assert_eq!(deserialized, variant);
        }
    }
}
