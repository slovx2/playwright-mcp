import { spawn } from 'node:child_process';
import net from 'node:net';

type ServiceTunnel = {
  id: string;
  targetPort: number;
  endpointPort: number;
  hiddenPort: number;
  server: net.Server;
  child: ReturnType<typeof spawn>;
  clients: Set<net.Socket>;
  activeConnections: number;
};

export class ServiceTunnels {
  #config;
  #services = new Map<string, ServiceTunnel>();
  #onActivity;
  #onLog;

  constructor(config, onActivity, onLog) {
    this.#config = config;
    this.#onActivity = onActivity;
    this.#onLog = onLog;
  }

  async open(id: string, targetPort: number): Promise<number> {
    if (!/^service-[0-9a-f-]{36}$/i.test(id) ||
        !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535)
      throw new Error('Invalid service tunnel request');
    const existing = this.#services.get(id);
    if (existing) {
      if (existing.targetPort !== targetPort)
        throw new Error('Service tunnel target changed');
      return existing.endpointPort;
    }
    const hiddenPort = await freePort();
    const child = spawn('/usr/bin/ssh', serviceForwardArguments(this.#config, hiddenPort, targetPort), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', data => {
      stderr = (stderr + data.toString()).slice(-4096);
      this.#onLog(data.toString().trimEnd());
    });
    try {
      await waitForForward(child, hiddenPort, () => stderr);
      const clients = new Set<net.Socket>();
      const server = net.createServer({ allowHalfOpen: true }, client => {
        clients.add(client);
        const service = this.#services.get(id);
        if (!service)
          return client.destroy();
        service.activeConnections++;
        this.#onActivity(id, service.activeConnections);
        const upstream = net.createConnection({
          port: hiddenPort, host: '127.0.0.1', allowHalfOpen: true,
        });
        clients.add(upstream);
        upstream.once('connect', () => {
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.once('error', error => client.destroy(error));
        client.once('error', () => upstream.destroy());
        client.once('close', () => {
          clients.delete(client);
          clients.delete(upstream);
          upstream.destroy();
          const current = this.#services.get(id);
          if (current) {
            current.activeConnections = Math.max(0, current.activeConnections - 1);
            this.#onActivity(id, current.activeConnections);
          }
        });
      });
      await listen(server);
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Failed to read service listener address');
      const service: ServiceTunnel = {
        id, targetPort, endpointPort: address.port, hiddenPort, server, child, clients,
        activeConnections: 0,
      };
      this.#services.set(id, service);
      child.once('exit', (code, signal) => {
        if (this.#services.get(id) === service) {
          this.#onLog(`Service tunnel ${id} SSH exited: code=${code} signal=${signal}`);
          void this.close(id);
        }
      });
      return service.endpointPort;
    } catch (error) {
      child.kill('SIGTERM');
      throw error;
    }
  }

  async close(id: string): Promise<void> {
    const service = this.#services.get(id);
    if (!service)
      return;
    this.#services.delete(id);
    for (const client of service.clients)
      client.destroy();
    service.child.kill('SIGTERM');
    await new Promise<void>(resolve => service.server.close(() => resolve()));
    this.#onActivity(id, 0);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#services.keys()].map(id => this.close(id)));
  }
}

export function serviceForwardArguments(config, localPort: number, targetPort: number): string[] {
  return [
    '-N', '-T', '-p', String(config.ssh.port), '-l', config.ssh.user,
    '-i', config.ssh.identityFile,
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${config.ssh.knownHostsFile}`,
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ClearAllForwardings=yes', '-o', 'GatewayPorts=no',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${targetPort}`,
    config.ssh.host,
  ];
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Failed to allocate service tunnel port');
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

function listen(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.listen(0, '127.0.0.1', resolve).once('error', reject));
}

async function waitForForward(child, port: number, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`SSH service forwarding failed: ${stderr() || `exit ${child.exitCode}`}`);
    const connected = await new Promise<boolean>(resolve => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (connected)
      return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`SSH service forwarding timed out: ${stderr()}`);
}
