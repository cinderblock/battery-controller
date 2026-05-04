/**
 * Shared configuration for deployment scripts
 */

// Deployment configuration
export const DeployHost = process.env.DEPLOY_HOST || 'raspberrypi.local';
export const DeployPort = Number(process.env.DEPLOY_PORT) || 22;
export const DeployUser = process.env.DEPLOY_USER || 'pi';
export const DeployKey = process.env.DEPLOY_KEY;
// Remote paths
export const DeployAppDir = '/opt/battery-controller'; // Where to deploy the app
export const DeploySetupHome = `/home/${DeployUser}`; // Where to run setup from
// Remote systemd service configuration
export const DeployServiceName = 'battery-controller';

// Remote files
export const DeploySetupPath = `${DeploySetupHome}/setup.js`; // Path to setup script
export const DeployBunBin = `${DeploySetupHome}/.bun/bin/bun`; // Path to Bun binary
export const DeployEnvFile = `/etc/default/${DeployServiceName}`; // Environment file for systemd services
export const DeployDevServiceName = 'battery-controller-dev';
export const DeployBridgeServiceName = 'battery-controller-bridge';

// TCP bridge configuration (used by bridge mode on Pi and proxy on Windows)
export const BridgeTcpPort = 49600;
