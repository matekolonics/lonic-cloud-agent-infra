use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEnvelope {
    pub command_id: String,
    #[serde(rename = "type")]
    pub command_type: CommandType,
    pub payload: serde_json::Value,
    pub callback_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CommandType {
    // Spec-based operations
    SynthPipeline,
    SynthInfrastructure,
    // CDK project operations
    SynthCdkProject,
    DiscoverStacks,
    // Stack deployment
    DeployStacks,
    DestroyStacks,
    // Stack management
    DescribeStacks,
    DetectDrift,
    GetChangeset,
    // Pipeline operations
    StartExecution,
    GetExecutionStatus,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_command_envelope() {
        let json = r#"{
            "commandId": "cmd-abc123",
            "type": "deploy-stacks",
            "payload": { "stacks": ["AppStack"] },
            "callbackUrl": "https://api.lonic.dev/agent/callback/cmd-abc123"
        }"#;

        let envelope: CommandEnvelope = serde_json::from_str(json).unwrap();
        assert_eq!(envelope.command_id, "cmd-abc123");
        assert_eq!(envelope.command_type, CommandType::DeployStacks);
        assert_eq!(envelope.callback_url, "https://api.lonic.dev/agent/callback/cmd-abc123");
        assert_eq!(envelope.payload["stacks"][0], "AppStack");
    }

    #[test]
    fn serialize_command_envelope_uses_camel_case() {
        let envelope = CommandEnvelope {
            command_id: "cmd-1".into(),
            command_type: CommandType::DescribeStacks,
            payload: serde_json::json!({}),
            callback_url: "https://example.com/cb".into(),
        };

        let json = serde_json::to_value(&envelope).unwrap();
        assert!(json.get("commandId").is_some());
        assert!(json.get("type").is_some());
        assert!(json.get("callbackUrl").is_some());
        assert_eq!(json["type"], "describe-stacks");
    }

    #[test]
    fn command_type_roundtrip_all_variants() {
        let variants = [
            (CommandType::SynthPipeline, "synth-pipeline"),
            (CommandType::SynthInfrastructure, "synth-infrastructure"),
            (CommandType::SynthCdkProject, "synth-cdk-project"),
            (CommandType::DiscoverStacks, "discover-stacks"),
            (CommandType::DeployStacks, "deploy-stacks"),
            (CommandType::DestroyStacks, "destroy-stacks"),
            (CommandType::DescribeStacks, "describe-stacks"),
            (CommandType::DetectDrift, "detect-drift"),
            (CommandType::GetChangeset, "get-changeset"),
            (CommandType::StartExecution, "start-execution"),
            (CommandType::GetExecutionStatus, "get-execution-status"),
        ];

        for (variant, expected_str) in variants {
            let json = serde_json::to_value(&variant).unwrap();
            assert_eq!(json, expected_str);

            let deserialized: CommandType = serde_json::from_value(json).unwrap();
            assert_eq!(deserialized, variant);
        }
    }
}
