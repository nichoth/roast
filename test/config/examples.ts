// Example configs the config tests load. The schema test checks that
// every one validates against the generated editor schema.

// The commented toplevel config the gate tests use.
export const GATE_EXAMPLE = `// Project config
{
    "version": 1,
    /* gate section */
    "gate": {
        "timeout_seconds": 42,
        "severity": "MEDIUM", // lowest blocking severity
    },
}
`

export const EXAMPLE_CONFIGS:readonly string[] = [
    '{"version": 1}',
    `{
        "$schema": "./node_modules/@substrate-system/roast/roast.schema.json",
        "version": 1,
        "inference_profiles": {
            "openai": {"model": "gpt-5.5", "protocol": "responses"},
            "claude": {
                "model": "claude-opus-5-5",
                "protocol": "anthropic",
                "max_output_tokens": 16000
            },
            "gateway": {
                "endpoint": "https://gateway.example.com/v1",
                "model": "m",
                "protocol": "chat",
                "api_key_env": "GATEWAY_KEY",
                "session_header": "X-Session"
            }
        },
        "roles": {
            "finder": {
                "profile": "openai",
                "pin": false,
                "author_routes": {"openai": "claude"}
            },
            "verifier": {"profile": "claude"}
        },
        "review": {
            "confidence_floor": 0.5,
            "quick_confidence_floor": 0.9,
            "excludes": ["vendor/**"],
            "snapshot": true
        },
        "prompts": {"finder_code": "prompts/finder.md"},
        "limits": {
            "deadline": "5m",
            "request_timeout": "90s",
            "max_total_tokens": 0,
            "max_diff_bytes": 1,
            "max_prompt_bytes": 100,
            "max_file_ctx_bytes": 100,
            "max_attempts": 1,
            "max_verified": 0
        },
        "interactive": {"min_files": 0, "min_diff_lines": 10},
        "gate": {"timeout_seconds": 0, "severity": "MEDIUM", "offer": false}
    }`,
]
