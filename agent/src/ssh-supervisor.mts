import { spawn } from 'node:child_process';

import { FramedStream } from './framing.mjs';

export class SSHSupervisor {
  #config;
  #child;
  #stopped = false;
  #attempt = 0;
  #timer;
  handlers: any;

  constructor(config, handlers) {
    this.#config = config;
    this.handlers = handlers;
  }

  start() {
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#child?.kill('SIGTERM');
  }

  #connect() {
    if (this.#stopped)
      return;
    const args = sshArguments(this.#config);
    const child = spawn('/usr/bin/ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    const stream = new FramedStream(child.stdout, child.stdin);
    let ready = false;
    const prefaceTimer = setTimeout(() => {
      this.handlers.onError(new Error('Browser Agent SSH preface timeout'));
      child.kill('SIGTERM');
    }, 30_000);
    stream.on('ready', () => {
      clearTimeout(prefaceTimer);
      ready = true;
      this.#attempt = 0;
      this.handlers.onConnection(stream);
    });
    stream.on('streamerror', error => this.handlers.onError(error));
    child.stderr.on('data', data => this.handlers.onLog(data.toString().trimEnd()));
    child.on('error', error => this.handlers.onError(error));
    child.on('exit', (code, signal) => {
      clearTimeout(prefaceTimer);
      if (this.#child === child)
        this.#child = undefined;
      this.handlers.onDisconnect({ ready, code, signal });
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.#stopped)
      return;
    const base = Math.min(60_000, 1000 * 2 ** Math.min(this.#attempt++, 6));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.#timer = setTimeout(() => this.#connect(), delay);
  }
}

export function sshArguments(config) {
  return [
    '-T', '-p', String(config.ssh.port), '-l', config.ssh.user,
    '-i', config.ssh.identityFile,
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${config.ssh.knownHostsFile}`,
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15', '-o', 'ClearAllForwardings=yes',
    config.ssh.host, 'tyrs-hand-dev', 'browser', 'proxy',
  ];
}
