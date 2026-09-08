export type SSHConfig = {
  host: string;
  port: number;
  user: string;
  identityFile: string;
  knownHostsFile: string;
};

export type WorkerConfig = {
  id: string;
  ssh: SSHConfig;
};

export type AgentConfig = {
  extensionId: string;
  extensionToken: string;
  extensionCrxPath: string;
  instanceId: string;
  publicPort: number;
  proxyPort: number;
  workers: WorkerConfig[];
};

export function validateConfig(value: any): AgentConfig {
  const required = ['extensionId', 'extensionToken', 'extensionCrxPath', 'instanceId'];
  for (const name of required) {
    if (typeof value[name] !== 'string' || !value[name])
      throw new Error(`Browser Agent config is missing ${name}`);
  }
  if (!/^[a-p]{32}$/.test(value.extensionId) || !/^[a-f0-9]{64}$/.test(value.extensionToken) ||
      !/^[0-9a-f-]{36}$/i.test(value.instanceId))
    throw new Error('Browser Agent identity config is invalid');
  if (!pathIsAbsolute(value.extensionCrxPath))
    throw new Error('Browser Agent extension path must be absolute');

  const workers = normalizeWorkers(value);
  const ids = new Set<string>();
  for (const worker of workers) {
    if (ids.has(worker.id))
      throw new Error(`Browser Agent worker ID is duplicated: ${worker.id}`);
    ids.add(worker.id);
    validateWorker(worker);
  }

  const publicPort = validPort(value.publicPort, 8931);
  const proxyPort = validPort(value.proxyPort, 8932);
  if (publicPort === proxyPort)
    throw new Error('Browser Agent public and proxy ports must differ');
  return {
    extensionId: value.extensionId,
    extensionToken: value.extensionToken,
    extensionCrxPath: value.extensionCrxPath,
    instanceId: value.instanceId,
    publicPort,
    proxyPort,
    workers,
  };
}

function normalizeWorkers(value: any): WorkerConfig[] {
  if (Array.isArray(value.workers)) {
    if (value.workers.length === 0)
      throw new Error('Browser Agent needs at least one worker');
    return value.workers.map((worker: any) => ({
      id: typeof worker?.id === 'string' ? worker.id : '',
      ssh: worker?.ssh,
    }));
  }
  if (value.ssh)
    return [{ id: 'default', ssh: value.ssh }];
  throw new Error('Browser Agent needs at least one worker');
}

function validateWorker(worker: WorkerConfig) {
  if (!worker.id || !/^[A-Za-z0-9_.:-]+$/.test(worker.id))
    throw new Error(`Browser Agent worker ID is invalid: ${worker.id}`);
  const ssh = worker.ssh;
  if (!ssh || typeof ssh.host !== 'string' || typeof ssh.user !== 'string' ||
      typeof ssh.identityFile !== 'string' || typeof ssh.knownHostsFile !== 'string')
    throw new Error(`Browser Agent SSH config is invalid for worker ${worker.id}`);
  if (!pathIsAbsolute(ssh.identityFile) || !pathIsAbsolute(ssh.knownHostsFile) ||
      !/^[A-Za-z0-9_.:-]+$/.test(ssh.host) || ssh.host.startsWith('-') ||
      !/^[A-Za-z0-9._-]+$/.test(ssh.user))
    throw new Error(`Browser Agent SSH target is invalid for worker ${worker.id}`);
  ssh.port = validPort(ssh.port, 22);
}

function validPort(value: unknown, fallback: number): number {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`Browser Agent port is invalid: ${value}`);
  return port;
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith('/');
}
