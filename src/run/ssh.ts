/**
 * Utility functions for deployment scripts
 */

import { posix as pathPosix } from 'node:path';
import { createInterface as ReadLine } from 'node:readline';
import type { ClientChannel, ConnectConfig, FileEntryWithStats, SFTPWrapper } from 'ssh2';
import { Client } from 'ssh2';
import { logger } from '../utils/logger.ts';

export interface SSHConfig {
  host: string;
  user: string;
  port?: number;
  keyPath?: string;
}

let sshConnection: Client | null = null;
let connectingPromise: Promise<Client> | null = null;

/**
 * Check if an error is an abort error (expected when operations are cancelled)
 */
function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === 'File write aborted' || error.message === 'SSH command aborted';
}

/**
 * Get or create SSH connection
 */
function getSSHConnection(config: SSHConfig): Promise<Client> | Client {
  if (sshConnection) {
    return sshConnection;
  }

  if (connectingPromise) {
    return connectingPromise;
  }

  const sshConfig: ConnectConfig = {
    host: config.host,
    username: config.user,
    port: config.port || 22,
    agent: '\\\\.\\pipe\\openssh-ssh-agent',
    readyTimeout: 15000,
  };

  if (config.keyPath) {
    throw new Error('Private key path is not yet supported');
    // sshConfig.privateKey = await Bun.file(config.keyPath).text();
  }

  connectingPromise = new Promise<Client>((resolve, reject) => {
    const client = new Client();

    const resetState = () => {
      sshConnection = null;
      connectingPromise = null;
    };

    client
      .on('ready', () => {
        sshConnection = client;
        connectingPromise = null;
        client.once('close', resetState);
        client.once('error', resetState);
        resolve(client);
      })
      .on('error', (error: Error) => {
        connectingPromise = null;
        reject(error);
      })
      .connect(sshConfig);
  });

  return connectingPromise;
}

function formatCommandFailure(cmd: string, code: number, stdout: string, stderr: string): string {
  const sections: string[] = [`Remote command "${cmd}" exited with code ${code}.`];

  const limit = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length <= 2000) return trimmed;
    return `${trimmed.slice(0, 1997)}...`;
  };

  if (stderr.trim()) sections.push(`stderr:\n${limit(stderr)}`);
  if (stdout.trim() && stdout.trim() !== stderr.trim()) sections.push(`stdout:\n${limit(stdout)}`);

  return sections.join('\n\n');
}

/**
 * Close SSH connection
 */
export async function closeSSHConnection(): Promise<void> {
  if (sshConnection) {
    try {
      sshConnection.end();
    } catch {}
    sshConnection = null;
  }
}

let sftp: Promise<SFTPWrapper> | null = null;
let sftpLock: Promise<unknown> | null = null;

async function doSFTP<T>(
  config: SSHConfig,
  atomic: (sftp: SFTPWrapper) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const client = await getSSHConnection(config);

  sftp ||= new Promise((resolve, reject) => client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))));

  const s = await sftp;

  while (sftpLock) await sftpLock;

  signal?.throwIfAborted();

  const result = atomic(s);

  sftpLock = result.then(() => {
    sftpLock = null;
  });

  return result;
}

export async function readdir(config: SSHConfig, path: string, signal?: AbortSignal): Promise<FileEntryWithStats[]> {
  return await doSFTP(
    config,
    sftp => {
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => sftp.readdir(path, (err, files) => (err ? reject(err) : resolve(files))));
    },
    signal
  );
}

export async function unlink(config: SSHConfig, file: string, signal?: AbortSignal): Promise<void> {
  return await doSFTP(
    config,
    sftp => {
      signal?.throwIfAborted();
      logger.debug(`📤 Removing file ${file}`);
      return new Promise((resolve, reject) => sftp.unlink(file, err => (err ? reject(err) : resolve())));
    },
    signal
  );
}

/**
 * Execute command over SSH
 */
export async function sshExec(
  config: SSHConfig,
  command: string,
  params: string[] = [],
  signal?: AbortSignal,
  streamToTerminal = false
): Promise<string> {
  signal?.throwIfAborted();

  const cmd = [command, ...params].join(' ');
  logger.debug(`📤 Executing command ${cmd} on remote...`);

  const execOnce = async (): Promise<string> => {
    const conn = await getSSHConnection(config);

    return new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      conn.exec(cmd, (err, channel) => {
        if (err) return reject(err);

        const ch = channel as ClientChannel;

        if (streamToTerminal) {
          ReadLine({ input: ch, crlfDelay: Infinity }).on('line', (line: string) => {
            // Skip empty lines
            if (!line.trim()) return;

            // Strip timestamp prefix from remote logger output (format: [HH:mm:ss] message)
            const stripped = line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '');
            if (stripped.trim()) {
              logger.info(`[remote] ${stripped}`);
              stdout += `${stripped}\n`;
            }
          });
          ReadLine({ input: ch.stderr, crlfDelay: Infinity }).on('line', (line: string) => {
            if (!line.trim()) return;

            const stripped = line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '');
            if (stripped.trim()) {
              logger.error(`[remote] ${stripped}`);
              stderr += `${stripped}\n`;
            }
          });
        } else {
          ch.on('data', (data: Buffer | string) => {
            stdout += data.toString();
          });
          ch.stderr.on('data', (data: Buffer | string) => {
            stderr += data.toString();
          });
        }

        const onAbort = () => {
          try {
            ch.close();
          } catch {}
          reject(new Error('SSH command aborted'));
        };
        if (signal) {
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
        }

        ch.on('close', (code: number) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          if (code === 0) resolve(stdout);
          else reject(new Error(formatCommandFailure(cmd, code, stdout, stderr)));
        });

        ch.on('error', (error: Error) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(error);
        });
      });
    });
  };

  try {
    return await execOnce();
  } catch (_error) {
    sshConnection = null;
    return await execOnce();
  }
}

export async function getTempFile(config: SSHConfig): Promise<string> {
  const result = await sshExec(config, 'mktemp', ['-t', 'ssh2-promise-XXXXXX']);
  return result.trim();
}

/**
 * Write file content to remote host via SFTP
 */
export async function writeRemoteFile(
  config: SSHConfig,
  content: string | Uint8Array,
  remotePath: string,
  useSudoMv = false,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();

  const putOnce = async (): Promise<void> => {
    const readFile = useSudoMv ? await getTempFile(config) : remotePath;

    await doSFTP(
      config,
      async sftp => {
        signal?.throwIfAborted();

        return new Promise<void>((resolve, reject) => {
          const writeStream = sftp.createWriteStream(readFile);

          const onAbort = () => {
            try {
              writeStream.destroy();
            } catch {}
            reject(new Error('File write aborted'));
          };

          if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
          }

          writeStream.on('error', (error: Error) => {
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(error);
          });
          writeStream.on('close', () => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
          });

          if (typeof content === 'string') {
            writeStream.write(content, 'utf-8');
          } else {
            writeStream.write(content);
          }
          writeStream.end();
        });
      },
      signal
    );

    if (useSudoMv) await sshExec(config, 'sudo mv', [readFile, remotePath]);
  };

  try {
    logger.debug(`📝 Writing file ${remotePath}`);
    await putOnce();
    logger.debug(`✅ File ${remotePath} written`);
  } catch (_error) {
    if (isAbortError(_error)) {
      logger.debug(`Upload aborted for ${remotePath}`);
      throw _error; // Re-throw abort errors so they propagate
    } else {
      logger.error(`❌ Error writing file ${remotePath}: ${_error}`);
      sshConnection = null;
      await putOnce();
    }
  }
}

export interface StagedRemoteFile {
  remotePath: string;
  content: string | Uint8Array;
}

function buildTempPath(remotePath: string): string {
  const dirName = pathPosix.dirname(remotePath || '/tmp');
  const baseName = pathPosix.basename(remotePath || 'file');
  const safeBase = baseName.replace(/[^A-Za-z0-9._-]/g, '_');
  const unique = Math.random().toString(16).slice(2);
  const dir = dirName && dirName !== '.' ? dirName : '/tmp';
  return `${dir}/.tmp-upload-${unique}-${safeBase || 'file'}`;
}

/**
 * Write multiple files to temporary paths via SFTP, then rename each to its final
 * destination only after all uploads complete. Uses SFTP rename (no shell mv).
 */
export async function writeRemoteFilesStaged(
  config: SSHConfig,
  files: StagedRemoteFile[],
  signal?: AbortSignal
): Promise<void> {
  if (!files.length) return;

  signal?.throwIfAborted();
  const staged: { tempPath: string; remotePath: string }[] = [];

  const writeToTemp = async (file: StagedRemoteFile): Promise<string> => {
    const tempPath = buildTempPath(file.remotePath);

    await doSFTP(
      config,
      sftp => {
        signal?.throwIfAborted();

        return new Promise<void>((resolve, reject) => {
          const writeStream = sftp.createWriteStream(tempPath);

          const onAbort = () => {
            try {
              writeStream.destroy();
            } catch {}
            reject(new Error('File write aborted'));
          };

          if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
          }

          writeStream.on('error', (error: Error) => {
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(error);
          });
          writeStream.on('close', () => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
          });

          if (typeof file.content === 'string') {
            writeStream.write(file.content, 'utf-8');
          } else {
            writeStream.write(file.content);
          }
          writeStream.end();
        });
      },
      signal
    );

    return tempPath;
  };

  try {
    // Upload all files to temporary locations first
    for (const file of files) {
      signal?.throwIfAborted();
      const tempPath = await writeToTemp(file);
      staged.push({ tempPath, remotePath: file.remotePath });
      logger.debug(`📝 Staged ${file.remotePath} -> ${tempPath}`);
    }
  } catch (error) {
    if (isAbortError(error)) {
      logger.debug('Batch upload aborted before rename');
      throw error;
    }
    logger.error(`❌ Error staging files: ${error}`);
    throw error;
  }

  // After all uploads succeed, rename each staged file into place
  for (const { tempPath, remotePath } of staged) {
    signal?.throwIfAborted();
    await doSFTP(
      config,
      sftp => {
        signal?.throwIfAborted();

        return new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            reject(new Error('File write aborted'));
          };

          if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
          }

          const doRename = () =>
            sftp.rename(tempPath, remotePath, err => {
              if (signal) signal.removeEventListener('abort', onAbort);
              if (err) return reject(err);
              resolve();
            });

          // Best-effort delete existing file to avoid servers that reject overwrite
          sftp.unlink(remotePath, () => {
            // Ignore unlink errors (file may not exist)
            doRename();
          });
        });
      },
      signal
    );

    logger.debug(`✅ Renamed ${tempPath} -> ${remotePath}`);
  }
}

/**
 * Check if SSH connection is working
 */
export async function checkSSHConnection(config: SSHConfig): Promise<boolean> {
  try {
    await sshExec(config, 'echo', ['Connection successful']);
    return true;
  } catch (_error) {
    logger.error('SSH connection failed');
    logger.error(_error);
    return false;
  }
}
