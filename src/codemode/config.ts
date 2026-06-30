export type CodeModeNetworkDefault = "allow" | "deny";

export type CodeModeConfig = {
  codeMode: {
    enabled: boolean;
  };
  execution: {
    timeoutMs: number;
    cpuMs: number;
    maxSteps: number;
    maxGeneratedCodeBytes: number;
    maxResultBytes: number;
    maxLogBytes: number;
  };
  network: {
    default: CodeModeNetworkDefault;
  };
  secrets: {
    exposeToSandbox: boolean;
  };
  modules: {
    npmImports: boolean;
    remoteImports: boolean;
  };
  state: {
    enabled: boolean;
  };
  filesystem: {
    enabled: boolean;
  };
  mcp: {
    enabled: boolean;
  };
  capabilities: {
    enabled: boolean;
  };
  observability: {
    recordCode: boolean;
    recordLogs: boolean;
    recordResult: boolean;
  };
  rateLimits: {
    codeModeRunsPerMinute: number;
    concurrentCodeModeRuns: number;
  };
};

export type CodeModeConfigResult =
  | { ok: true; config: CodeModeConfig }
  | { ok: false; error: string };

type CodeModeEnv = {
  CODE_MODE_ENABLED?: string;
  CODE_MODE_TIMEOUT_MS?: string;
  CODE_MODE_CPU_MS?: string;
  CODE_MODE_MAX_STEPS?: string;
  CODE_MODE_MAX_GENERATED_CODE_BYTES?: string;
  CODE_MODE_MAX_RESULT_BYTES?: string;
  CODE_MODE_MAX_LOG_BYTES?: string;
  CODE_MODE_NETWORK_DEFAULT?: string;
  CODE_MODE_EXPOSE_SECRETS?: string;
  CODE_MODE_NPM_IMPORTS?: string;
  CODE_MODE_REMOTE_IMPORTS?: string;
  CODE_MODE_STATE_ENABLED?: string;
  CODE_MODE_FILESYSTEM_ENABLED?: string;
  CODE_MODE_MCP_ENABLED?: string;
  CODE_MODE_CAPABILITIES_ENABLED?: string;
  CODE_MODE_RECORD_CODE?: string;
  CODE_MODE_RECORD_LOGS?: string;
  CODE_MODE_RECORD_RESULT?: string;
  CODE_MODE_RUNS_PER_MINUTE?: string;
  CODE_MODE_CONCURRENT_RUNS?: string;
};

export const DEFAULT_CODE_MODE_CONFIG: CodeModeConfig = {
  codeMode: {
    enabled: false,
  },
  execution: {
    timeoutMs: 30000,
    cpuMs: 1000,
    maxSteps: 10,
    maxGeneratedCodeBytes: 100000,
    maxResultBytes: 100000,
    maxLogBytes: 50000,
  },
  network: {
    default: "allow",
  },
  secrets: {
    exposeToSandbox: false,
  },
  modules: {
    npmImports: false,
    remoteImports: false,
  },
  state: {
    enabled: false,
  },
  filesystem: {
    enabled: false,
  },
  mcp: {
    enabled: false,
  },
  capabilities: {
    enabled: false,
  },
  observability: {
    recordCode: true,
    recordLogs: true,
    recordResult: true,
  },
  rateLimits: {
    codeModeRunsPerMinute: 20,
    concurrentCodeModeRuns: 3,
  },
};

const MAX_CODE_MODE_LIMITS = {
  timeoutMs: 300000,
  cpuMs: 30000,
  maxSteps: 100,
  maxGeneratedCodeBytes: 1000000,
  maxResultBytes: 5000000,
  maxLogBytes: 1000000,
  codeModeRunsPerMinute: 10000,
  concurrentCodeModeRuns: 1000,
};

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

type ConfigAssignment = readonly [name: string, assign: () => string | null];

export function loadCodeModeConfig(env: CodeModeEnv): CodeModeConfigResult {
  const config = structuredClone(DEFAULT_CODE_MODE_CONFIG);
  const assignments: ConfigAssignment[] = [
    ["CODE_MODE_ENABLED", () => assignBoolean(env.CODE_MODE_ENABLED, (value) => (config.codeMode.enabled = value))],
    [
      "CODE_MODE_TIMEOUT_MS",
      () => assignPositiveInteger(env.CODE_MODE_TIMEOUT_MS, (value) => (config.execution.timeoutMs = value), MAX_CODE_MODE_LIMITS.timeoutMs),
    ],
    ["CODE_MODE_CPU_MS", () => assignPositiveInteger(env.CODE_MODE_CPU_MS, (value) => (config.execution.cpuMs = value), MAX_CODE_MODE_LIMITS.cpuMs)],
    [
      "CODE_MODE_MAX_STEPS",
      () => assignPositiveInteger(env.CODE_MODE_MAX_STEPS, (value) => (config.execution.maxSteps = value), MAX_CODE_MODE_LIMITS.maxSteps),
    ],
    [
      "CODE_MODE_MAX_GENERATED_CODE_BYTES",
      () =>
        assignPositiveInteger(
          env.CODE_MODE_MAX_GENERATED_CODE_BYTES,
          (value) => (config.execution.maxGeneratedCodeBytes = value),
          MAX_CODE_MODE_LIMITS.maxGeneratedCodeBytes,
        ),
    ],
    [
      "CODE_MODE_MAX_RESULT_BYTES",
      () =>
        assignPositiveInteger(env.CODE_MODE_MAX_RESULT_BYTES, (value) => (config.execution.maxResultBytes = value), MAX_CODE_MODE_LIMITS.maxResultBytes),
    ],
    [
      "CODE_MODE_MAX_LOG_BYTES",
      () => assignPositiveInteger(env.CODE_MODE_MAX_LOG_BYTES, (value) => (config.execution.maxLogBytes = value), MAX_CODE_MODE_LIMITS.maxLogBytes),
    ],
    ["CODE_MODE_NETWORK_DEFAULT", () => assignNetworkDefault(env.CODE_MODE_NETWORK_DEFAULT, (value) => (config.network.default = value))],
    [
      "CODE_MODE_EXPOSE_SECRETS",
      () => assignBoolean(env.CODE_MODE_EXPOSE_SECRETS, (value) => (config.secrets.exposeToSandbox = value)),
    ],
    ["CODE_MODE_NPM_IMPORTS", () => assignBoolean(env.CODE_MODE_NPM_IMPORTS, (value) => (config.modules.npmImports = value))],
    ["CODE_MODE_REMOTE_IMPORTS", () => assignBoolean(env.CODE_MODE_REMOTE_IMPORTS, (value) => (config.modules.remoteImports = value))],
    ["CODE_MODE_STATE_ENABLED", () => assignBoolean(env.CODE_MODE_STATE_ENABLED, (value) => (config.state.enabled = value))],
    [
      "CODE_MODE_FILESYSTEM_ENABLED",
      () => assignBoolean(env.CODE_MODE_FILESYSTEM_ENABLED, (value) => (config.filesystem.enabled = value)),
    ],
    ["CODE_MODE_MCP_ENABLED", () => assignBoolean(env.CODE_MODE_MCP_ENABLED, (value) => (config.mcp.enabled = value))],
    [
      "CODE_MODE_CAPABILITIES_ENABLED",
      () => assignBoolean(env.CODE_MODE_CAPABILITIES_ENABLED, (value) => (config.capabilities.enabled = value)),
    ],
    ["CODE_MODE_RECORD_CODE", () => assignBoolean(env.CODE_MODE_RECORD_CODE, (value) => (config.observability.recordCode = value))],
    ["CODE_MODE_RECORD_LOGS", () => assignBoolean(env.CODE_MODE_RECORD_LOGS, (value) => (config.observability.recordLogs = value))],
    ["CODE_MODE_RECORD_RESULT", () => assignBoolean(env.CODE_MODE_RECORD_RESULT, (value) => (config.observability.recordResult = value))],
    [
      "CODE_MODE_RUNS_PER_MINUTE",
      () =>
        assignPositiveInteger(
          env.CODE_MODE_RUNS_PER_MINUTE,
          (value) => (config.rateLimits.codeModeRunsPerMinute = value),
          MAX_CODE_MODE_LIMITS.codeModeRunsPerMinute,
        ),
    ],
    [
      "CODE_MODE_CONCURRENT_RUNS",
      () =>
        assignPositiveInteger(
          env.CODE_MODE_CONCURRENT_RUNS,
          (value) => (config.rateLimits.concurrentCodeModeRuns = value),
          MAX_CODE_MODE_LIMITS.concurrentCodeModeRuns,
        ),
    ],
  ];

  for (const [name, assign] of assignments) {
    const error = assign();
    if (error) {
      return { ok: false, error: `${name}: ${error}` };
    }
  }

  const unsupportedMvpOption = unsupportedMvpOptionError(config);
  if (unsupportedMvpOption) {
    return { ok: false, error: unsupportedMvpOption };
  }

  return { ok: true, config };
}

function unsupportedMvpOptionError(config: CodeModeConfig) {
  const unsupportedOptions: Array<[enabled: boolean, message: string]> = [
    [config.secrets.exposeToSandbox, "CODE_MODE_EXPOSE_SECRETS must remain false for the MVP"],
    [config.modules.npmImports, "CODE_MODE_NPM_IMPORTS is not supported in the MVP"],
    [config.modules.remoteImports, "CODE_MODE_REMOTE_IMPORTS is not supported in the MVP"],
    [config.state.enabled, "CODE_MODE_STATE_ENABLED is not supported in the MVP"],
    [config.filesystem.enabled, "CODE_MODE_FILESYSTEM_ENABLED is not supported in the MVP"],
    [config.mcp.enabled, "CODE_MODE_MCP_ENABLED is not supported in the MVP"],
    [config.capabilities.enabled, "CODE_MODE_CAPABILITIES_ENABLED is not supported in the MVP"],
  ];

  return unsupportedOptions.find(([enabled]) => enabled)?.[1] ?? null;
}

function assignBoolean(raw: string | undefined, assign: (value: boolean) => void) {
  if (raw === undefined || raw.trim().length === 0) {
    return null;
  }

  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    assign(true);
    return null;
  }
  if (FALSE_VALUES.has(normalized)) {
    assign(false);
    return null;
  }

  return "must be a boolean";
}

function assignPositiveInteger(raw: string | undefined, assign: (value: number) => void, max?: number) {
  if (raw === undefined || raw.trim().length === 0) {
    return null;
  }

  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    return "must be a positive integer";
  }
  if (max !== undefined && value > max) {
    return `must be <= ${max}`;
  }

  assign(value);
  return null;
}

function assignNetworkDefault(raw: string | undefined, assign: (value: CodeModeNetworkDefault) => void) {
  if (raw === undefined || raw.trim().length === 0) {
    return null;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "allow" || normalized === "deny") {
    assign(normalized);
    return null;
  }

  return "must be allow or deny";
}
