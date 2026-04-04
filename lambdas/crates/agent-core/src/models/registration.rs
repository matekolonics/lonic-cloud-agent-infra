use serde::{Deserialize, Serialize};

/// Payload sent to the hosted backend when the agent registers itself.
/// This happens on stack deploy/update so the backend knows about this agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRegistration {
    pub agent_id: String,
    pub agent_version: String,
    pub region: String,
    pub account_id: String,
    pub capabilities: Vec<String>,
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn serialize_agent_registration() {
        let reg = AgentRegistration {
            agent_id: "agent-abc123".into(),
            agent_version: "0.1.0".into(),
            region: "us-east-1".into(),
            account_id: "123456789012".into(),
            capabilities: vec![
                "deploy-stacks".into(),
                "destroy-stacks".into(),
                "describe-stacks".into(),
            ],
            timestamp: chrono::Utc.with_ymd_and_hms(2026, 4, 4, 10, 0, 0).unwrap(),
        };

        let json = serde_json::to_value(&reg).unwrap();
        assert_eq!(json["agentId"], "agent-abc123");
        assert_eq!(json["agentVersion"], "0.1.0");
        assert_eq!(json["region"], "us-east-1");
        assert_eq!(json["accountId"], "123456789012");
        assert_eq!(json["capabilities"][0], "deploy-stacks");
        assert_eq!(json["capabilities"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn deserialize_agent_registration_roundtrip() {
        let reg = AgentRegistration {
            agent_id: "agent-xyz".into(),
            agent_version: "0.2.0".into(),
            region: "eu-west-1".into(),
            account_id: "987654321098".into(),
            capabilities: vec!["deploy-stacks".into()],
            timestamp: chrono::Utc.with_ymd_and_hms(2026, 4, 4, 12, 0, 0).unwrap(),
        };

        let json_str = serde_json::to_string(&reg).unwrap();
        let deserialized: AgentRegistration = serde_json::from_str(&json_str).unwrap();
        assert_eq!(deserialized.agent_id, "agent-xyz");
        assert_eq!(deserialized.region, "eu-west-1");
        assert_eq!(deserialized.capabilities.len(), 1);
    }
}
