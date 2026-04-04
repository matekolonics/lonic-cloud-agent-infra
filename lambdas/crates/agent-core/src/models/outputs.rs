use serde::{Deserialize, Serialize};

/// Output from synth commands (synth-pipeline, synth-infrastructure, synth-cdk-project).
/// Contains the S3 location of the synthesised CloudFormation templates.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthOutput {
    pub artifact_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stacks_discovered: Option<Vec<String>>,
}

/// Output from describe-stacks command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescribeStacksOutput {
    pub stacks: Vec<StackDescription>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackDescription {
    pub stack_name: String,
    pub stack_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack_status_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outputs: Option<Vec<StackOutput>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Vec<StackParameter>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackOutput {
    pub output_key: String,
    pub output_value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackParameter {
    pub parameter_key: String,
    pub parameter_value: String,
}

/// Output from discover-stacks command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverStacksOutput {
    pub stacks: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_synth_output() {
        let output = SynthOutput {
            artifact_uri: "s3://bucket/artifacts/cdk.out.zip".into(),
            build_id: Some("project:build-123".into()),
            stacks_discovered: Some(vec!["AppStack".into(), "NetworkStack".into()]),
        };

        let json = serde_json::to_value(&output).unwrap();
        assert_eq!(json["artifactUri"], "s3://bucket/artifacts/cdk.out.zip");
        assert_eq!(json["buildId"], "project:build-123");
        assert_eq!(json["stacksDiscovered"][0], "AppStack");
    }

    #[test]
    fn serialize_synth_output_omits_none_fields() {
        let output = SynthOutput {
            artifact_uri: "s3://bucket/out.zip".into(),
            build_id: None,
            stacks_discovered: None,
        };

        let json = serde_json::to_value(&output).unwrap();
        assert!(json.get("buildId").is_none());
        assert!(json.get("stacksDiscovered").is_none());
    }

    #[test]
    fn serialize_describe_stacks_output() {
        let output = DescribeStacksOutput {
            stacks: vec![StackDescription {
                stack_name: "AppStack".into(),
                stack_status: "CREATE_COMPLETE".into(),
                stack_status_reason: None,
                outputs: Some(vec![StackOutput {
                    output_key: "ServiceUrl".into(),
                    output_value: "https://example.com".into(),
                }]),
                parameters: Some(vec![StackParameter {
                    parameter_key: "Environment".into(),
                    parameter_value: "production".into(),
                }]),
            }],
        };

        let json = serde_json::to_value(&output).unwrap();
        assert_eq!(json["stacks"][0]["stackName"], "AppStack");
        assert_eq!(json["stacks"][0]["stackStatus"], "CREATE_COMPLETE");
        assert!(json["stacks"][0].get("stackStatusReason").is_none());
        assert_eq!(json["stacks"][0]["outputs"][0]["outputKey"], "ServiceUrl");
        assert_eq!(json["stacks"][0]["parameters"][0]["parameterKey"], "Environment");
    }

    #[test]
    fn deserialize_describe_stacks_roundtrip() {
        let output = DescribeStacksOutput {
            stacks: vec![
                StackDescription {
                    stack_name: "NetworkStack".into(),
                    stack_status: "UPDATE_COMPLETE".into(),
                    stack_status_reason: None,
                    outputs: None,
                    parameters: None,
                },
                StackDescription {
                    stack_name: "AppStack".into(),
                    stack_status: "CREATE_FAILED".into(),
                    stack_status_reason: Some("Resource limit exceeded".into()),
                    outputs: None,
                    parameters: None,
                },
            ],
        };

        let json_str = serde_json::to_string(&output).unwrap();
        let deserialized: DescribeStacksOutput = serde_json::from_str(&json_str).unwrap();
        assert_eq!(deserialized.stacks.len(), 2);
        assert_eq!(deserialized.stacks[1].stack_status_reason.as_deref(), Some("Resource limit exceeded"));
    }

    #[test]
    fn serialize_discover_stacks_output() {
        let output = DiscoverStacksOutput {
            stacks: vec!["NetworkStack".into(), "AppStack".into(), "MonitoringStack".into()],
        };

        let json = serde_json::to_value(&output).unwrap();
        assert_eq!(json["stacks"].as_array().unwrap().len(), 3);
        assert_eq!(json["stacks"][0], "NetworkStack");
    }
}
