#!/usr/bin/env bun

/**
 * Development Deployment Script
 *
 * Runs on development machine. Builds project in memory, transfers to Pi via SSH,
 * starts dev service with --watch, and monitors for changes.
 *
 * Usage:
 *   bun start                   # Deploy and watch for changes
 *   bun start --once            # Deploy once without watching
 */

import { logger } from '../utils/logger.ts';
import { shutdown } from '../utils/shutdown.ts';
import type { BuildOptions, BuildOutput, BuildResult } from './build.ts';
import { buildWatchInMemory } from './build.ts';
import {
  DeployAppDir,
  DeployBunBin,
  DeployDevServiceName,
  DeployHost,
  DeployKey,
  DeployPort,
  DeployServiceName,
  DeploySetupHome,
  DeploySetupPath,
  DeployUser,
} from './config.ts';
import {
  checkSSHConnection,
  closeSSHConnection,
  readdir,
  type SSHConfig,
  type StagedRemoteFile,
  sshExec,
  unlink,
  writeRemoteFilesStaged,
} from './ssh.ts';

interface DeployConfig {
  sshConfig: SSHConfig;
}

/**
 * Check if an error is an abort error (expected when operations are cancelled)
 */
function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === 'File write aborted' || error.message === 'SSH command aborted';
}

async function loadConfig(): Promise<DeployConfig> {
  return {
    sshConfig: {
      host: DeployHost,
      user: DeployUser,
      keyPath: DeployKey,
      port: DeployPort,
    },
  };
}

function log(message: string, emoji = '📦') {
  logger.info(`${emoji} ${message}`);
}

async function ensureBunInstalled(config: DeployConfig, signal?: AbortSignal): Promise<void> {
  logger.debug('Checking if Bun is installed on remote...');

  try {
    const version = await sshExec(config.sshConfig, DeployBunBin, ['--version'], signal);
    logger.debug(`Bun ${version.trim()} already installed`);
    return;
  } catch {
    logger.debug('Bun not found, installing...');
  }

  signal?.throwIfAborted();

  // Install Bun using official installer
  logger.debug('Downloading and installing Bun...');
  await sshExec(config.sshConfig, 'curl -fsSL https://bun.sh/install | bash', [], signal);

  signal?.throwIfAborted();

  // Verify installation
  try {
    const version = await sshExec(config.sshConfig, DeployBunBin, ['--version'], signal);
    logger.debug(`Bun ${version.trim()} installed successfully`);
  } catch {
    throw new Error('Failed to install Bun on remote host');
  }
}

async function deploySetupBundle(config: DeployConfig, setupBundle: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  logger.debug('Transferring setup bundle to Pi...');

  await writeRemoteFilesStaged(config.sshConfig, [{ content: setupBundle, remotePath: DeploySetupPath }], signal);

  logger.debug('Setup bundle deployed');
}

async function runSetup(config: DeployConfig, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  log('Running setup on Pi...', '⚙️');

  // Setup script calls sudo internally for privileged operations
  await runBunOnRemote(config, [DeploySetupPath], DeploySetupHome, signal, true);
}

async function deployPackageFiles(config: DeployConfig, signal?: AbortSignal): Promise<void> {
  logger.debug('Transferring package files...');

  // Read and transfer server package.json
  const content = await Bun.file('src/server/package.json').text();
  await writeRemoteFilesStaged(config.sshConfig, [{ content, remotePath: `${DeployAppDir}/package.json` }], signal);

  logger.debug('Package files deployed');
}

async function runBunOnRemote(
  config: DeployConfig,
  command: string[],
  cwd = DeployAppDir,
  signal?: AbortSignal,
  streamToTerminal = false,
  env?: Record<string, string>
): Promise<void> {
  logger.debug(`Running command ${command.join(' ')} on remote...`);

  // Prefix with env exports when provided to override remote defaults (e.g., frozen lockfile)
  const envArgs = env ? Object.entries(env).map(([key, value]) => `${key}=${value}`) : [];
  const baseArgs = ['--smol', ...command, '--cwd', cwd].filter(Boolean);

  const isEnvCall = envArgs.length > 0;
  const execCommand = isEnvCall ? 'env' : DeployBunBin;
  const params = isEnvCall ? [...envArgs, DeployBunBin, ...baseArgs] : baseArgs;

  await sshExec(config.sshConfig, execCommand, params, signal, streamToTerminal);
}

async function installRemoteDependencies(config: DeployConfig, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  logger.debug('Installing dependencies on remote...');

  // Install production dependencies in app directory
  await runBunOnRemote(config, ['install', '--production'], DeployAppDir, signal, true, {
    BUN_INSTALL_FROZEN_LOCKFILE: '0',
  });

  logger.debug('Dependencies installed');
}

function sortFilenamesForDeploy(files: string[]): string[] {
  return [...files].sort((a, b) => {
    // Assets: CSS files and files with hash in name (e.g., index-abc123.js)
    const aIsAsset = a.endsWith('.css') || /^[^-]+-[^-]+\.(js|css)$/.test(a);
    const bIsAsset = b.endsWith('.css') || /^[^-]+-[^-]+\.(js|css)$/.test(b);

    if (aIsAsset && !bIsAsset) return -1; // assets first
    if (!aIsAsset && bIsAsset) return 1;
    return a.localeCompare(b); // alphabetical within same category
  });
}

async function deployBuildOutputs(
  config: DeployConfig,
  outputs: BuildOutput[],
  signal?: AbortSignal,
  cleanupPreserveFiles?: string[]
): Promise<void> {
  if (!outputs.length) return;

  // De-dupe by filename (last one wins)
  const byName = new Map<string, string>();
  for (const output of outputs) byName.set(output.filename, output.content);

  const filenames = sortFilenamesForDeploy([...byName.keys()]);
  if (!filenames.length) return;

  logger.debug(`Transferring ${filenames.length} file${filenames.length !== 1 ? 's' : ''}...`);

  const stagedFiles: StagedRemoteFile[] = filenames.map(filename => ({
    content: byName.get(filename) ?? '',
    remotePath: `${DeployAppDir}/${filename}`,
  }));

  await writeRemoteFilesStaged(config.sshConfig, stagedFiles, signal);
  for (const file of stagedFiles) {
    logger.debug(`  ✅ ${file.remotePath.replace(`${DeployAppDir}/`, '')}`);
  }

  // Clean up old files last if requested
  if (cleanupPreserveFiles) {
    const preserve = new Set(cleanupPreserveFiles);
    const desired = new Set(filenames);

    const remoteFiles = (await readdir(config.sshConfig, DeployAppDir, signal))
      .filter(file => file.attrs.isFile())
      .map(file => file.filename);

    const sourceFiles = remoteFiles.filter(file => !preserve.has(file));
    const extraFiles = sourceFiles.filter(file => !desired.has(file));

    if (extraFiles.length > 0) {
      logger.debug(`Cleaning up ${extraFiles.length} extra file${extraFiles.length !== 1 ? 's' : ''}...`);
      // Cleanup sequentially to avoid SSH channel exhaustion
      for (const file of extraFiles) {
        await unlink(config.sshConfig, `${DeployAppDir}/${file}`, signal);
      }
    }
  }
}

async function startService(config: DeployConfig, serviceName: string, signal?: AbortSignal): Promise<void> {
  logger.debug(`Starting ${serviceName} service...`);
  signal?.throwIfAborted();

  try {
    // Start service (systemd will handle if already running)
    await sshExec(config.sshConfig, 'sudo systemctl start', [serviceName], signal);

    logger.debug(`${serviceName} started`);
  } catch (error: unknown) {
    logErrorMessage(`Failed to start ${serviceName}:`, error);
    logger.debug('Checking service status...');
    await sshExec(config.sshConfig, 'journalctl', ['-u', serviceName, '-n', '20', '--no-pager'], signal);
    throw error;
  }

  signal?.throwIfAborted();
}

async function stopService(config: DeployConfig, serviceName: string, signal?: AbortSignal): Promise<void> {
  try {
    await sshExec(config.sshConfig, 'sudo systemctl stop', [serviceName], signal);
    logger.debug(`${serviceName} stopped`);
  } catch {
    // Service might not be running, that's ok
    logger.debug(`${serviceName} was not running`);
  }
}

async function checkStatus(
  config: DeployConfig,
  signal?: AbortSignal,
  serviceName = DeployDevServiceName
): Promise<void> {
  signal?.throwIfAborted();
  logger.debug('Checking deployment status...');

  try {
    await sshExec(config.sshConfig, 'systemctl status', [serviceName], signal);
  } catch (_error) {
    logger.warn('⚠️  Service may not be running properly');
  }
}

async function performInitialDeploy(
  config: DeployConfig,
  buildResult: BuildResult,
  signal?: AbortSignal
): Promise<void> {
  log('Starting initial deployment...', '🚀');

  // Check SSH connection
  signal?.throwIfAborted();
  logger.debug('Checking SSH connection...');
  if (!(await checkSSHConnection(config.sshConfig))) {
    throw new Error(`Cannot connect to ${config.sshConfig.user}@${config.sshConfig.host}`);
  }
  logger.debug('SSH connection OK');

  // Ensure Bun is installed on remote
  await ensureBunInstalled(config, signal);

  // Read setup bundle from build result
  signal?.throwIfAborted();
  const setupContent = buildResult.setup;
  if (!setupContent) {
    throw new Error('Setup bundle missing from build result');
  }
  await deploySetupBundle(config, setupContent, signal);

  // Run setup (creates directories, installs system deps, configures services)
  await runSetup(config, signal);

  // Deploy package files and install dependencies
  await deployPackageFiles(config, signal);
  await installRemoteDependencies(config, signal);

  // Deploy all build outputs (setup.js + server bundle files)
  const serverOutputs = buildResult.server;
  if (!serverOutputs || serverOutputs.length === 0) {
    throw new Error('Server bundle missing from build result');
  }
  const appOutputs: BuildOutput[] = [{ filename: 'setup.js', content: setupContent }, ...serverOutputs];
  await deployBuildOutputs(config, appOutputs, signal, ['package.json', 'bun.lock']);
  log(`Files deployed (${appOutputs.length} file${appOutputs.length !== 1 ? 's' : ''})`, '✅');

  // Start dev service (systemd handles if already running)
  await startService(config, DeployDevServiceName, signal);

  // Check status
  await checkStatus(config, signal);

  log('Initial deployment complete!', '🎉');
}

function logErrorMessage(prefix: string, err: unknown): void {
  if (err instanceof Error) {
    logger.error(`${prefix} ${err.message}`);
    if (err.stack) {
      logger.debug(err.stack);
    }
  } else {
    logger.error(`${prefix} ${String(err)}`);
  }
}

function createIncrementalDeployHandler(config: DeployConfig) {
  let currentDeployId = 0;
  let currentAbortController: AbortController | null = null;
  let isDeploying = false;

  const triggerDeploy = async (result: BuildResult, options: BuildOptions, changedFiles: Set<string>) => {
    // Abort any in-progress deploy step (uploads or setup run)
    if (currentAbortController) {
      logger.debug('Aborting previous deploy...');
      currentAbortController.abort();
    }

    // Wait for previous deploy to finish cleaning up
    while (isDeploying) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Start new deploy with fresh abort controller
    const deployId = ++currentDeployId;
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;
    isDeploying = true;

    try {
      // If setup.ts changed, upload and re-run setup on the Pi (do NOT stop services).
      const setupTsChanged = changedFiles.has('run/setup.ts');
      if (setupTsChanged) {
        if (!result.setup) {
          logger.warn('setup.ts changed, but setup bundle was missing from build result');
        } else {
          await deploySetupBundle(config, result.setup, signal);
          await runSetup(config, signal);
        }
      }

      // Deploy build outputs to app dir
      const outputs: BuildOutput[] = [];
      if (options.setup) {
        if (!result.setup) {
          logger.warn('Build indicated setup output, but setup bundle was missing');
        } else {
          // Keep a copy of setup.js in the app dir (matches prior disk-based deploy behavior)
          outputs.push({ filename: 'setup.js', content: result.setup });
        }
      }
      if (options.server) {
        if (!result.server) {
          logger.warn('Build indicated server output, but server bundle was missing');
        } else {
          outputs.push(...result.server);
        }
      }
      if (outputs.length === 0) return;

      // Only cleanup remote files when server outputs are rebuilt; setup-only rebuilds must not delete the app bundle.
      const cleanupPreserveFiles = options.server ? ['package.json'] : undefined;
      await deployBuildOutputs(config, outputs, signal, cleanupPreserveFiles);

      // Only log success if we weren't aborted
      if (deployId === currentDeployId && !signal.aborted) {
        logger.debug(`Deploy complete: ${outputs.length} file${outputs.length !== 1 ? 's' : ''}`);
      }
    } catch (err) {
      // Only log errors if we weren't aborted and are still current
      if (deployId === currentDeployId && !signal.aborted && !isAbortError(err)) {
        logErrorMessage('Deploy error:', err);
      } else if (signal.aborted || isAbortError(err)) {
        logger.debug('Deploy aborted, superseded by new changes');
      }
    } finally {
      isDeploying = false;
      // Clear abort controller if we're still the current deploy
      if (deployId === currentDeployId) currentAbortController = null;
    }
  };

  // Debounced deploy to batch rapid rebuilds
  const debouncedDeploy = debounce((result: BuildResult, options: BuildOptions, changedFiles: Set<string>) => {
    triggerDeploy(result, options, changedFiles);
  }, 100);

  return (result: BuildResult, options: BuildOptions, changedFiles: Set<string>) => {
    const builtFileCount =
      (options.setup && result.setup ? 1 : 0) + (options.server && result.server ? result.server.length : 0);
    logger.debug(`Build complete: ${builtFileCount} file${builtFileCount !== 1 ? 's' : ''}`);
    debouncedDeploy(result, options, changedFiles);
  };
}

/**
 * Run a function after a delay, but skip if the function is called again within the delay.
 * @param fn - The function to debounce.
 * @param delay - The delay in milliseconds.
 * @returns A function that can be called to debounce the input value.
 */
function debounce<T extends unknown[]>(fn: (...args: T) => void, delay: number) {
  let timeout: NodeJS.Timeout;
  return (...args: T) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      fn(...args);
    }, delay);
  };
}

async function main() {
  const config = await loadConfig();
  const onceMode = process.argv.includes('--once');

  log('Battery Charge & Discharge Controller - Development Deployment', '🔧');
  logger.debug(`📡 Target: ${config.sshConfig.user}@${config.sshConfig.host}`);
  logger.debug(`📂 App Dir: ${DeployAppDir}`);
  if (onceMode) {
    logger.debug('🎯 Mode: Deploy once (no watch)');
  }

  // Use watch mode for all builds (including the initial build). The deploy pipeline must not write build artifacts to local disk.
  const incrementalDeploy = createIncrementalDeployHandler(config);

  let initialBuild: BuildResult | null = null;
  let initialDeployComplete = false;
  let pendingAfterInit: { result: BuildResult; options: BuildOptions; changedFiles: Set<string> } | null = null;

  // Start build watch process (does initial build before starting the file watcher)
  const buildCleanup = await buildWatchInMemory((result, options, changedFiles) => {
    // Capture the initial build for initial deployment
    if (!initialBuild) {
      initialBuild = result;
      return;
    }

    // If initial deploy hasn't finished yet, keep only the latest build and apply it after init.
    if (!initialDeployComplete) {
      pendingAfterInit = { result, options, changedFiles };
      return;
    }

    incrementalDeploy(result, options, changedFiles);
  }, false);

  if (!initialBuild) {
    buildCleanup();
    await closeSSHConnection();
    throw new Error('Initial build did not produce a build result');
  }

  // Perform initial deployment (must run setup before starting the dev service)
  try {
    await performInitialDeploy(config, initialBuild);
  } catch (err) {
    buildCleanup();
    logErrorMessage('❌ Initial deployment failed:', err);
    await closeSSHConnection();
    shutdown(1);
  }

  if (onceMode) {
    buildCleanup();
    log('Deployment complete! Exiting (--once mode)', '✅');
    await closeSSHConnection();
    return;
  }

  // Watch mode enabled: process any queued build, then keep running until SIGINT/SIGTERM.
  log('Starting watch mode...', '👀');
  logger.debug('Monitoring: src/ for file changes');
  initialDeployComplete = true;
  if (pendingAfterInit) {
    incrementalDeploy(pendingAfterInit.result, pendingAfterInit.options, pendingAfterInit.changedFiles);
    pendingAfterInit = null;
  }

  // Exit handler: start main service and stop dev service
  const exitHandler = async () => {
    log('Stopping watch mode...', '👋');

    buildCleanup();

    try {
      logger.debug('Stopping dev service...');
      await stopService(config, DeployDevServiceName);

      logger.debug('Starting main service...');
      await startService(config, DeployServiceName);
    } catch (error) {
      logErrorMessage('Error during cleanup:', error);
    }

    await closeSSHConnection();
    shutdown(0);
  };

  process.on('SIGINT', exitHandler);
  process.on('SIGTERM', exitHandler);
}

main().catch(async error => {
  logErrorMessage('❌ Deployment failed:', error);
  await closeSSHConnection();
  shutdown(1);
});
