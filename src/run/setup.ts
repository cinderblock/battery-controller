#!/usr/bin/env bun

/**
 * Raspberry Pi Setup Script
 *
 * This script runs ON the Raspberry Pi as a compiled binary.
 * Called by deploy.ts from the development machine.
 *
 * Assumes:
 * - User can sudo without password
 *
 * Does:
 * - Installs system dependencies
 * - Creates/updates systemd services
 * - Sets up directory structure
 * - Configures permissions
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile as writeFileFS } from 'node:fs/promises';
import { logger } from '../utils/logger.ts';
import { shutdown } from '../utils/shutdown.ts';
import {
  DeployAppDir,
  DeployBunBin,
  DeployEnvFile,
  DeployServiceName,
} from './config.ts';

export const SystemdServiceDir = '/etc/systemd/system';

function log(message: string, emoji = 'ℹ️') {
  logger.info(`${emoji} ${message}`);
}

/**
 * Run a command locally pass/fail
 * @param command
 * @param args
 * @returns
 */
async function exec(command: string, args: string[] = [], stream = false): Promise<boolean> {
  const cp = spawn(command, args, {
    stdio: stream ? 'inherit' : 'pipe',
    // shell: true,
  });

  const status = await new Promise<number>((resolve, reject) => {
    cp.on('close', resolve);
    cp.on('error', reject);
  });

  return status === 0;
}

async function sudoExec(command: string, args: string[] = [], stream = false): Promise<boolean> {
  return exec('sudo', [command, ...args], stream);
}

async function sudoExecCapture(
  command: string,
  args: string[] = []
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return execCaptureAsync('sudo', [command, ...args]);
}

/**
 * Run a command locally and capture the output
 */
async function execCapture(command: string, args: string[] = []): Promise<string> {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    // shell: true,
  });
  return result.stdout.toString();
}

/**
 * Run a command asynchronously and capture both stdout and stderr
 * @param command
 * @param args
 * @returns Object with success status and captured output
 */
async function execCaptureAsync(
  command: string,
  args: string[] = []
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const cp = spawn(command, args, {
    stdio: 'pipe',
    // shell: true,
  });

  let stdout = '';
  let stderr = '';

  cp.stdout?.on('data', (data: Buffer) => {
    stdout += data.toString();
  });

  cp.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  const status = await new Promise<number>((resolve, reject) => {
    cp.on('close', resolve);
    cp.on('error', reject);
  });

  return {
    success: status === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

async function installDependencies() {
  const updateTimestampPath = 'lastAptUpdate.txt';
  const oneDayInMillis = 24 * 60 * 60 * 1000;

  const lastUpdated = await readFile(updateTimestampPath, 'utf8').catch(() => {});

  if (lastUpdated) {
    const lastUpdatedTime = new Date(lastUpdated).getTime();
    const now = Date.now();

    if (now - lastUpdatedTime < oneDayInMillis) {
      log('Apt update recently run; skipping update.');
      return;
    }
  }

  writeFile(updateTimestampPath, new Date().toISOString()).catch(error => {
    logger.error('Failed to write update timestamp:', error);
  });

  log('Installing system dependencies...', '📦');

  // Update package list
  const updateResult = await sudoExecCapture('apt-get', ['update', '-qq']);
  if (!updateResult.success) {
    logger.error('apt-get update failed');
    if (updateResult.stdout) {
      logger.error('stdout:', updateResult.stdout);
    }
    if (updateResult.stderr) {
      logger.error('stderr:', updateResult.stderr);
    }
    throw new Error('Failed to update package list');
  }

  const upgradeResult = await sudoExecCapture('apt-get', ['upgrade', '-y', '-qq']);
  if (!upgradeResult.success) {
    logger.error('apt-get upgrade failed');
    if (upgradeResult.stdout) {
      logger.error('stdout:', upgradeResult.stdout);
    }
    if (upgradeResult.stderr) {
      logger.error('stderr:', upgradeResult.stderr);
    }
    throw new Error('Failed to upgrade packages');
  }

  // Install required packages
  const packages: string[] = [
    'ffmpeg', // Camera frame capture from RTSP stream
  ];

  if (packages.length === 0) {
    log('No dependencies to install', '✅');
    return;
  }

  log(`Installing: ${packages.join(', ')}`);

  const installResult = await sudoExecCapture('apt-get', ['install', '-y', '-qq', ...packages]);
  if (!installResult.success) {
    logger.error('apt-get install failed');
    if (installResult.stdout) {
      logger.error('stdout:', installResult.stdout);
    }
    if (installResult.stderr) {
      logger.error('stderr:', installResult.stderr);
    }
    throw new Error('Failed to install dependencies');
  }

  log('Dependencies installed', '✅');
}

async function setRaspiConfig(option: string, enabled: boolean) {
  await sudoExec('raspi-config', ['nonint', option, enabled ? '0' : '1']);
}

async function configureBootConfig() {
  log('Configuring boot config for UART access...', '🔧');

  // Try both possible config locations (newer Pi OS uses /boot/firmware/config.txt)
  const configPaths = ['/boot/firmware/config.txt', '/boot/config.txt'];
  const overlayLine = 'dtoverlay=pi3-disable-bt';

  let configPath: string | null = null;

  // Find which config file exists
  for (const path of configPaths) {
    try {
      await readFile(path, 'utf-8');
      configPath = path;
      log(`Using config file: ${path}`, '📁');
      break;
    } catch {
      // Continue to next path
    }
  }

  if (!configPath) {
    throw new Error('Could not find boot config file in either /boot/firmware/config.txt or /boot/config.txt');
  }

  try {
    // Read current config
    const currentConfig = await readFile(configPath, 'utf-8');

    // Check if overlay is already present
    if (currentConfig.includes(overlayLine)) {
      log('pi3-disable-bt overlay already configured', '✅');
      return;
    }

    // Add overlay to config
    const updatedConfig = currentConfig + '\n' + overlayLine + '\n';

    // Write updated config
    await writeFile(configPath, updatedConfig, true);

    log(`pi3-disable-bt overlay added to ${configPath}`, '✅');

    log('Rebooting for changes to take effect...', '🔄');

    await sudoExec('reboot');

    process.exit(0);
  } catch (error) {
    log(`Failed to configure ${configPath}: ${error}`, '❌');
    throw error;
  }
}

async function setupPiHardware() {
  log('Setting up Pi hardware...', '🔧');

  await setRaspiConfig('do_serial_cons', false); // Disable console on serial port
  await setRaspiConfig('do_serial_hw', true); // Enable serial port hardware
  await setRaspiConfig('do_onewire', true); // Enable 1-Wire interface (GPIO 4) for DS18B20 temp sensors

  // Add pi3-disable-bt overlay to free up UART for serial communication
  await configureBootConfig();

  // TODO: reboot for changes to take effect

  log('Pi hardware setup complete', '✅');
}

async function createDirectories() {
  log('Creating application directories...', '📁');

  await sudoExec('mkdir', ['-p', `${DeployAppDir}/data`]);
  await sudoExec('chown', ['-R', 'pi:', DeployAppDir]);

  log('Directories created', '✅');
}
const ServiceFileName = `${SystemdServiceDir}/${DeployServiceName}.service`;

function serviceContent() {
  return `[Unit]
Description=Battery Charge & Discharge Controller Service
After=network.target

[Service]
WorkingDirectory=${DeployAppDir}
ExecStart=${DeployBunBin} ${DeployAppDir}
EnvironmentFile=-${DeployEnvFile}
Environment="NODE_ENV=production"
Environment="DB_PATH=${DeployAppDir}/data/battery.db"
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
}

async function ensureFileIs(path: string, content: string, sudo = false) {
  const existingContent = await readFile(path, 'utf-8').catch(() => {});
  if (existingContent === content) {
    return false;
  }

  await writeFile(path, content, sudo);
  log(`File ${path} updated`, '✅');
  return true;
}

async function mktemp() {
  return (await execCapture('mktemp', ['-t', 'setup-XXXXXX'])).trim();
}

async function writeFile(path: string, content: string, sudo = false) {
  try {
    log(`Writing file ${path}`, '📝');
    await writeFileFS(path, content);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EACCES' && sudo) {
      log(`Permission denied writing file ${path}, creating temporary file`, '📝');
      const tmp = await mktemp();
      await writeFileFS(tmp, content);
      await sudoExec('mv', [tmp, path]);
    } else {
      throw error;
    }
  }
}

/** Remove old dev and bridge services left over from previous setup versions */
async function cleanupOldServices() {
  const obsolete = ['battery-controller-dev', 'battery-controller-bridge'];
  for (const name of obsolete) {
    const unitFile = `${SystemdServiceDir}/${name}.service`;
    try {
      await readFile(unitFile, 'utf-8');
    } catch {
      continue; // File doesn't exist, nothing to clean up
    }
    log(`Removing obsolete service: ${name}`, '🧹');
    await sudoExec('systemctl', ['stop', name]).catch(() => {});
    await sudoExec('systemctl', ['disable', name]).catch(() => {});
    await sudoExec('rm', ['-f', unitFile]);
  }
}

async function setupSystemdServices() {
  log('Setting up systemd service...', '⚙️');

  await cleanupOldServices();

  const changed = await ensureFileIs(ServiceFileName, serviceContent(), true);

  if (changed) {
    await sudoExec('systemctl', ['daemon-reload']);
    log('Systemd reloaded', '✅');
  }

  // Enable service to start on boot
  await sudoExec('systemctl', ['enable', `${DeployServiceName}.service`]);

  log('Service enabled', '✅');
}

function displaySummary() {
  log('Setup Complete!', '🎉');
  logger.debug(`  📁 Application directory: ${DeployAppDir}`);
  logger.debug(`  🏃 Bun runtime: ${DeployBunBin}`);
  logger.debug(`  📦 Main entry: ${DeployAppDir}`);
  logger.debug(`  ⚙️  Service: ${ServiceFileName}`);
}

async function main() {
  log('Battery Charge & Discharge Controller - Raspberry Pi Setup', '🚀');

  const jobs = [];

  // Create application directories
  jobs.push(createDirectories());

  // Install system dependencies
  jobs.push(installDependencies());

  // Setup Pi Hardware
  jobs.push(setupPiHardware());

  // Create both systemd services
  jobs.push(setupSystemdServices());

  await Promise.all(jobs);

  // Summary
  displaySummary();
}

main().catch(error => {
  logger.error('❌ Setup failed:', error);
  shutdown(1);
});
