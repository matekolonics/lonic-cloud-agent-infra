/// Initialize structured JSON logging for Lambda.
///
/// Configures `tracing_subscriber` with:
/// - JSON output format (for CloudWatch structured logs)
/// - `RUST_LOG` env filter (defaults to `info` if not set)
/// - Target disabled (Lambda logs already include function name)
///
/// Call this once in each Lambda's `main()` before any tracing calls.
pub fn init_tracing() {
    tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
}
