export type ClientCommand =
  | { type: "prompt"; text: string }
  | { type: "steer"; text: string }
  | { type: "follow-up"; text: string }
  | { type: "abort" };

export type ServerEvent =
  | { type: "session"; sessionId: string }
  | { type: "assistant-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; name: string; output: string; isError?: boolean }
  | { type: "status"; text: string }
  | { type: "completed" }
  | { type: "aborted" }
  | { type: "error"; message: string };
