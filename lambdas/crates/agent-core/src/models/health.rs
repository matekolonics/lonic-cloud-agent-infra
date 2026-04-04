use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub agent_id: String,
    pub agent_version: String,
    pub region: String,
    pub account_id: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn serialize_health_response() {
        let response = HealthResponse {
            agent_id: "agent-abc".into(),
            agent_version: "0.1.0".into(),
            region: "us-east-1".into(),
            account_id: "123456789012".into(),
            timestamp: chrono::Utc.with_ymd_and_hms(2026, 4, 4, 10, 0, 0).unwrap(),
        };

        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["agentId"], "agent-abc");
        assert_eq!(json["agentVersion"], "0.1.0");
        assert_eq!(json["region"], "us-east-1");
        assert_eq!(json["accountId"], "123456789012");
        assert!(json.get("timestamp").is_some());
    }

    #[test]
    fn deserialize_health_response_roundtrip() {
        let response = HealthResponse {
            agent_id: "agent-xyz".into(),
            agent_version: "0.2.0".into(),
            region: "eu-west-1".into(),
            account_id: "987654321098".into(),
            timestamp: chrono::Utc.with_ymd_and_hms(2026, 4, 4, 12, 0, 0).unwrap(),
        };

        let json_str = serde_json::to_string(&response).unwrap();
        let deserialized: HealthResponse = serde_json::from_str(&json_str).unwrap();
        assert_eq!(deserialized.agent_id, "agent-xyz");
        assert_eq!(deserialized.agent_version, "0.2.0");
        assert_eq!(deserialized.region, "eu-west-1");
        assert_eq!(deserialized.account_id, "987654321098");
    }
}
