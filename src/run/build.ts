#!/usr/bin/env bun

/**
 * Build Script
 *
 * Builds the project using Bun.build() API.
 * Can be used programmatically or as a CLI.
 *
 * Usage:
 *   import { build } from './build';           // Programmatic (in-memory)
 *   import { buildWatch } from './build';      // Watch mode (writes to disk)
 *   bun run build                              // CLI (writes to disk)
 */

import { watch } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { logger } from '../utils/logger.ts';
import { shutdown } from '../utils/shutdown.ts';

export interface BuildOutput {
  filename: string;
  content: string | Uint8Array;
}

export interface BuildOptions {
  setup: boolean;
  server: boolean;
}

export interface BuildResult {
  setup?: string;
  server?: BuildOutput[];
}

/**
 * Read server package.json and extract dependency names for externals
 */
async function getServerExternals(): Promise<string[]> {
  try {
    const serverPackageJson = await Bun.file('./src/server/package.json').json();
    const dependencies = serverPackageJson.dependencies || {};
    return Object.keys(dependencies);
  } catch (error) {
    logger.warn('Failed to read src/server/package.json, no externals will be set:', error);
    return [];
  }
}

/**
 * Build setup bundle only
 */
export async function buildSetup(): Promise<string> {
  logger.info('📦 Building setup bundle...');
  const externals = await getServerExternals();
  const setupResult = await Bun.build({
    entrypoints: ['./src/run/setup.ts'],
    target: 'bun',
    minify: true,
    sourcemap: 'none',
    external: externals,
  });

  if (!setupResult.success) {
    logger.error('Setup build errors:', setupResult.logs);
    throw new Error('Failed to build setup bundle');
  }

  if (setupResult.outputs.length !== 1) {
    throw new Error(
      `Expected 1 setup output, got ${setupResult.outputs.length}: ${setupResult.outputs.map(output => output.path).join(', ')}`
    );
  }

  const setupContent = await setupResult.outputs[0].text();
  logger.info('✅ Setup bundle built');

  return setupContent;
}

/**
 * Build server bundle only
 */
export async function buildServer(): Promise<BuildOutput[]> {
  logger.info('📦 Building server bundle...');
  const externals = await getServerExternals();
  let serverResult: Awaited<ReturnType<typeof Bun.build>>;
  try {
    serverResult = await Bun.build({
      entrypoints: ['./src/server/index.ts'],
      target: 'bun',
      minify: true,
      sourcemap: 'none',
      external: externals,
      naming: {
        entry: '[name].[ext]',
        chunk: '[name]-[hash].[ext]',
        asset: '[name]-[hash].[ext]',
      },
    });
  } catch (error) {
    // Use console.error directly to ensure we see the actual error
    console.error('Server build exception caught:', error);
    console.error('Error type:', typeof error);
    console.error('Error constructor:', error?.constructor?.name);
    console.error('Error value:', String(error));
    if (error instanceof Error) {
      console.error('Error message:', error.message || '(no message)');
      console.error('Error stack:', error.stack || '(no stack)');
      console.error('Error name:', error.name);
    }
    try {
      console.error('Error JSON:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    } catch (e) {
      console.error('Could not stringify error:', e);
    }
    // Also log via logger with a single formatted message
    const errorDetails = [
      `type: ${typeof error}`,
      `constructor: ${error?.constructor?.name}`,
      `string: ${String(error)}`,
      error instanceof Error ? `message: ${error.message || '(no message)'}` : '',
      error instanceof Error ? `stack: ${error.stack || '(no stack)'}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    logger.error(`Server build exception: ${errorDetails}`);
    throw new Error(
      `Failed to build server bundle: ${error instanceof Error ? error.message || String(error) : String(error)}`
    );
  }

  if (!serverResult.success) {
    logger.error('Server build failed (success=false)');
    logger.error('Build logs:', JSON.stringify(serverResult.logs, null, 2));
    if (serverResult.logs && serverResult.logs.length > 0) {
      for (const log of serverResult.logs) {
        logger.error('Build log entry:', JSON.stringify(log, null, 2));
      }
    }
    throw new Error('Failed to build server bundle');
  }

  // Collect all server outputs
  const serverOutputs: BuildOutput[] = [];
  for (const output of serverResult.outputs) {
    const content = await output.text();
    if (dirname(output.path) !== '.') {
      throw new Error(`Output path ${output.path} is not a top level file`);
    }
    const filename = basename(output.path);
    serverOutputs.push({ filename, content });
    logger.info(`  ✅ ${filename}`);
  }

  // Include zbar.wasm static assets (barcode scanner)
  // Read from node_modules at build time so they deploy alongside the bundle
  // without needing npm install on the Pi.
  const zbarJsFile = Bun.file('./node_modules/zbar.wasm/dist/zbar.js');
  const zbarWasmFile = Bun.file('./node_modules/zbar.wasm/dist/zbar.wasm.bin');

  if ((await zbarJsFile.exists()) && (await zbarWasmFile.exists())) {
    serverOutputs.push({ filename: 'zbar.js', content: await zbarJsFile.text() });
    serverOutputs.push({ filename: 'zbar.wasm.bin', content: new Uint8Array(await zbarWasmFile.arrayBuffer()) });
    logger.info('  ✅ zbar.js + zbar.wasm.bin (static assets)');
  } else {
    logger.warn('⚠️  zbar.wasm not found in node_modules — barcode scanning will be unavailable');
  }

  logger.info(`✅ Server bundle built (${serverOutputs.length} file${serverOutputs.length !== 1 ? 's' : ''})`);

  return serverOutputs;
}

/**
 * Build project bundles in memory based on options
 */
export async function build(options: BuildOptions): Promise<BuildResult> {
  logger.info('🔨 Building project...');

  const buildPromises: Promise<unknown>[] = [];
  const result: BuildResult = {};

  if (options.setup) {
    buildPromises.push(
      buildSetup().then(setup => {
        result.setup = setup;
      })
    );
  }

  if (options.server) {
    buildPromises.push(
      buildServer().then(server => {
        result.server = server;
      })
    );
  }

  await Promise.all(buildPromises);

  logger.info('✨ Build complete!');

  return result;
}

/**
 * Build and write to disk
 */
export async function buildToDisk(options: BuildOptions, outDir = 'build'): Promise<Set<string>> {
  // Create build directory
  await mkdir(outDir, { recursive: true });

  // Build project
  const result = await build(options);

  // Track generated files
  const generatedFiles = new Set<string>();

  // Write files to disk
  if (result.setup) {
    await Bun.write(`${outDir}/setup.js`, result.setup);
    generatedFiles.add('setup.js');
  }

  if (result.server) {
    for (const output of result.server) {
      await Bun.write(`${outDir}/${output.filename}`, output.content);
      generatedFiles.add(output.filename);
    }
  }

  // Clean up stale files
  const existingFiles = await readdir(outDir);
  const staleFiles = existingFiles.filter(file => !generatedFiles.has(file));

  if (staleFiles.length > 0) {
    await Promise.all(
      staleFiles.map(async file => {
        const filePath = join(outDir, file);
        await rm(filePath, { recursive: true, force: true });
      })
    );
  }

  return generatedFiles;
}

/**
 * Watch mode: Build server and frontend when source files change
 * Returns a cleanup function to stop watching
 */
export async function buildWatch(
  outDir = 'build',
  onBuild?: (changedFiles: Set<string>) => void,
  skipInitialBuild = false
): Promise<() => void> {
  let isBuilding = false;
  let buildTimeout: NodeJS.Timeout | null = null;
  const changedFiles = new Set<string>();

  const determineBuildOptions = (files: Set<string>): BuildOptions => {
    let needsSetup = false;
    let needsServer = false;

    for (const file of files) {
      const normalized = file.replace(/\\/g, '/');

      if (normalized.match(/^run\/.*\.ts$/)) {
        needsSetup = true;
      }

      if (normalized.match(/^server\/.*\.ts$/) || normalized.match(/^frontend\/.*\.(tsx?|css|html)$/)) {
        needsServer = true;
      }

      if (normalized.match(/^(utils|shared)\/.*\.ts$/)) {
        // Shared dependencies - rebuild both
        needsSetup = true;
        needsServer = true;
      }
    }

    return { setup: needsSetup, server: needsServer };
  };

  const performBuild = async (options: BuildOptions) => {
    if (isBuilding) {
      return;
    }
    isBuilding = true;

    try {
      const files = await buildToDisk(options, outDir);
      if (onBuild) {
        onBuild(files);
      }
    } catch (error) {
      logger.error('❌ Build failed:', error);
    } finally {
      isBuilding = false;
    }
  };

  // Initial build (unless skipped)
  logger.debug(`📁 Output directory: ${outDir}`);
  if (!skipInitialBuild) {
    await performBuild({ setup: true, server: true });
  }
  logger.debug('👀 Watching for changes...');

  // Watch for changes
  const watcher = watch('src', { recursive: true, persistent: true }, (_eventType, filename) => {
    if (!filename) return;

    const normalizedFilename = filename.replace(/\\/g, '/');

    // Only watch relevant source files
    if (
      normalizedFilename.match(/^server\/.*\.ts$/) ||
      normalizedFilename.match(/^frontend\/.*\.(tsx?|css|html)$/) ||
      normalizedFilename.match(/^run\/.*\.ts$/) ||
      normalizedFilename.match(/^(utils|shared)\/.*\.ts$/)
    ) {
      // Track changed files
      changedFiles.add(normalizedFilename);

      // Debounce builds
      if (buildTimeout) {
        clearTimeout(buildTimeout);
      }
      buildTimeout = setTimeout(() => {
        const options = determineBuildOptions(changedFiles);
        const changedList = Array.from(changedFiles).join(', ');
        logger.debug(`🔄 Change detected: ${changedList}`);
        logger.debug(
          `📦 Rebuilding: ${options.setup ? 'setup' : ''}${options.setup && options.server ? ' + ' : ''}${options.server ? 'server' : ''}`
        );
        performBuild(options);
        changedFiles.clear();
      }, 100);
    }
  });

  // Return cleanup function
  return () => {
    watcher.close();
    if (buildTimeout) {
      clearTimeout(buildTimeout);
    }
  };
}

/**
 * Watch mode (in-memory): Build bundles in memory when source files change.
 * Returns a cleanup function to stop watching.
 */
export async function buildWatchInMemory(
  onBuild?: (result: BuildResult, options: BuildOptions, changedFiles: Set<string>) => void,
  skipInitialBuild = false
): Promise<() => void> {
  let isBuilding = false;
  let buildTimeout: NodeJS.Timeout | null = null;
  const changedFiles = new Set<string>();

  const determineBuildOptions = (files: Set<string>): BuildOptions => {
    let needsSetup = false;
    let needsServer = false;

    for (const file of files) {
      const normalized = file.replace(/\\/g, '/');

      if (normalized.match(/^run\/.*\.ts$/)) {
        needsSetup = true;
      }

      if (normalized.match(/^server\/.*\.ts$/) || normalized.match(/^frontend\/.*\.(tsx?|css|html)$/)) {
        needsServer = true;
      }

      if (normalized.match(/^(utils|shared)\/.*\.ts$/)) {
        // Shared dependencies - rebuild both
        needsSetup = true;
        needsServer = true;
      }
    }

    return { setup: needsSetup, server: needsServer };
  };

  const performBuild = async (options: BuildOptions, changed: Set<string>) => {
    if (isBuilding) {
      return;
    }
    isBuilding = true;

    try {
      const result = await build(options);
      if (onBuild) {
        onBuild(result, options, changed);
      }
    } catch (error) {
      logger.error('❌ Build failed:', error);
    } finally {
      isBuilding = false;
    }
  };

  // Initial build (unless skipped)
  if (!skipInitialBuild) {
    await performBuild({ setup: true, server: true }, new Set());
  }
  logger.debug('👀 Watching for changes (in-memory)...');

  // Watch for changes
  const watcher = watch('src', { recursive: true, persistent: true }, (_eventType, filename) => {
    if (!filename) return;

    const normalizedFilename = filename.replace(/\\/g, '/');

    // Only watch relevant source files
    if (
      normalizedFilename.match(/^server\/.*\.ts$/) ||
      normalizedFilename.match(/^frontend\/.*\.(tsx?|css|html)$/) ||
      normalizedFilename.match(/^run\/.*\.ts$/) ||
      normalizedFilename.match(/^(utils|shared)\/.*\.ts$/)
    ) {
      // Track changed files
      changedFiles.add(normalizedFilename);

      // Debounce builds
      if (buildTimeout) {
        clearTimeout(buildTimeout);
      }
      buildTimeout = setTimeout(() => {
        const changedSnapshot = new Set(changedFiles);
        const options = determineBuildOptions(changedFiles);
        const changedList = Array.from(changedFiles).join(', ');
        logger.debug(`🔄 Change detected: ${changedList}`);
        logger.debug(
          `📦 Rebuilding (in-memory): ${options.setup ? 'setup' : ''}${options.setup && options.server ? ' + ' : ''}${options.server ? 'server' : ''}`
        );
        changedFiles.clear();
        performBuild(options, changedSnapshot);
      }, 100);
    }
  });

  // Return cleanup function
  return () => {
    watcher.close();
    if (buildTimeout) {
      clearTimeout(buildTimeout);
    }
  };
}

// Run as CLI if executed directly
if (import.meta.main) {
  const watchMode = process.argv.includes('--watch');
  // argv[0]=bun, argv[1]=script — only actual CLI args can name the out dir
  const outDir = process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'build';

  if (watchMode) {
    buildWatch(outDir, files => {
      logger.debug(`✅ Build complete (${files.size} file${files.size !== 1 ? 's' : ''})`);
    })
      .then(cleanup => {
        process.on('SIGINT', () => {
          logger.info('👋 Stopping watch mode...');
          cleanup();
          shutdown(0);
        });
      })
      .catch(error => {
        logger.error('❌ Build watch failed:', error);
        shutdown(1);
      });
  } else {
    buildToDisk({ setup: true, server: true }, outDir)
      .then(files => {
        logger.info(`🎉 Build complete! (${files.size} file${files.size !== 1 ? 's' : ''})`);
      })
      .catch(error => {
        logger.error('❌ Build failed:', error);
        shutdown(1);
      });
  }
}
