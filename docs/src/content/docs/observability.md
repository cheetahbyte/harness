---
title: Observability
slug: observability
---

# Observability

Harnez can export lifecycle traces and metrics through OpenTelemetry. It is
disabled unless `HARNEZ_OTEL=1`. Configure the standard OpenTelemetry
environment variables, for example:

```text
HARNEZ_OTEL=1
OTEL_SERVICE_NAME=harnez
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

By default, events contain only IDs, status, durations, counts, model/tool
names, and context pressure fields. Prompt, response, tool argument/result,
MCP payload, and path fields are never captured unless explicitly listed in
`HARNEZ_OTEL_CAPTURE_CONTENT` as a comma-separated list. Credentials, API
keys, authorization headers, environment values, and image bytes are never
captured. Unknown capture names fail startup.

The useful context fields are `under_pressure`, `pressure_streak`, and
`agent_continued`. A collector query for tasks that kept working through
repeated pressure is:

```text
harnez.context.pressure_streak > 1 AND harnez.context.agent_continued = true
```

Telemetry configuration is removed before bash and stdio MCP child processes
start. Harnez does not create distributed child traces.
