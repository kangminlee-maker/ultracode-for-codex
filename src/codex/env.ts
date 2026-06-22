const DIRECT_PROVIDER_ENV_PREFIXES = [
  'ANTHROPIC',
  'AZURE_OPENAI',
  'COHERE',
  'DEEPSEEK',
  'GEMINI',
  'GOOGLE',
  'GROQ',
  'MISTRAL',
  'OPENAI',
  'OPENROUTER',
  'PERPLEXITY',
  'TOGETHER',
  'XAI',
] as const;

const DIRECT_PROVIDER_ENV_SUFFIXES = [
  'ACCESS_TOKEN',
  'API_BASE',
  'API_KEY',
  'AUTH_TOKEN',
  'BASE_URL',
  'ENDPOINT',
  'ORG_ID',
  'ORGANIZATION',
  'PROJECT',
] as const;

export function codexChildProcessEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || isDirectProviderEnvName(key)) continue;
    env[key] = value;
  }
  env.TERM = process.env.TERM && process.env.TERM !== 'dumb'
    ? process.env.TERM
    : 'xterm-256color';
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function isDirectProviderEnvName(name: string): boolean {
  return DIRECT_PROVIDER_ENV_PREFIXES.some((prefix) => (
    DIRECT_PROVIDER_ENV_SUFFIXES.some((suffix) => name === `${prefix}_${suffix}`)
  ));
}
