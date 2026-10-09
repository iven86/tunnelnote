export function resolveSshAgent(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string {
  const configuredAgent = environment.SSH_AUTH_SOCK?.trim();
  if (configuredAgent) {
    return configuredAgent;
  }
  if (platform === 'win32') {
    return 'pageant';
  }
  throw new Error(
    'No SSH agent socket is configured. Start ssh-agent and set SSH_AUTH_SOCK, or choose another authentication method.',
  );
}
