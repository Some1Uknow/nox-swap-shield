import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const frontendDirectory = resolve(scriptDirectory, '..', 'frontend');
const productionEnvFiles = ['.env', '.env.local', '.env.production', '.env.production.local'];
const allowedKeys = new Set([
  'VITE_TOKEN_IN_ADDRESS',
  'VITE_TOKEN_OUT_ADDRESS',
  'VITE_SHIELDED_TOKEN_IN_ADDRESS',
  'VITE_SHIELDED_TOKEN_OUT_ADDRESS',
  'VITE_SWAP_SHIELD_ROUTER_ADDRESS',
  'VITE_CHAIN_ID',
  'VITE_POOL_FEE',
]);
// Vercel injects this public observability payload at build time. Keep it out
// of dotenv files and permit only this exact platform-managed VITE_ key; an
// arbitrary VITE_ variable could otherwise accidentally expose configuration
// that should never reach the browser bundle.
const allowedBuildEnvironmentKeys = new Set([
  ...allowedKeys,
  'VITE_VERCEL_OBSERVABILITY_CLIENT_CONFIG',
]);
const addressKeys = [
  'VITE_TOKEN_IN_ADDRESS',
  'VITE_TOKEN_OUT_ADDRESS',
  'VITE_SHIELDED_TOKEN_IN_ADDRESS',
  'VITE_SHIELDED_TOKEN_OUT_ADDRESS',
  'VITE_SWAP_SHIELD_ROUTER_ADDRESS',
];
const addressPattern = /^0x[a-fA-F0-9]{40}$/;

function parseEnv(source, fileName) {
  const values = {};
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`${fileName}:${index + 1} is not a valid KEY=value entry.`);
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function assertAllowedKeys(values, label, permittedKeys = allowedKeys) {
  for (const key of Object.keys(values)) {
    if (!permittedKeys.has(key)) {
      throw new Error(`${label} contains ${key}. Browser configuration may contain only the documented public VITE_ deployment values.`);
    }
  }
}

function assertPublicConfig(values) {
  for (const key of addressKeys) {
    if (!addressPattern.test(values[key] || '')) {
      throw new Error(`Missing or invalid ${key} in the production frontend configuration.`);
    }
  }

  const chainId = Number(values.VITE_CHAIN_ID);
  if (chainId !== 11155111) {
    throw new Error('VITE_CHAIN_ID must be exactly 11155111 for this Sepolia-only build.');
  }
  const poolFee = Number(values.VITE_POOL_FEE);
  if (!Number.isSafeInteger(poolFee) || poolFee <= 0 || poolFee > 2 ** 24 - 1) {
    throw new Error('VITE_POOL_FEE must be a positive uint24 integer.');
  }
}

async function loadProductionConfig() {
  const knownFiles = new Set(productionEnvFiles);
  const names = await readdir(frontendDirectory);
  const unexpected = names.filter((name) => name.startsWith('.env') && name !== '.env.example' && !knownFiles.has(name));
  if (unexpected.length) {
    throw new Error(`Unexpected frontend environment file(s): ${unexpected.join(', ')}. Keep release configuration in ${productionEnvFiles.join(', ')} only.`);
  }

  const values = {};
  let sawConfigFile = false;
  for (const name of productionEnvFiles) {
    try {
      const contents = await readFile(resolve(frontendDirectory, name), 'utf8');
      const parsed = parseEnv(contents, `frontend/${name}`);
      assertAllowedKeys(parsed, `frontend/${name}`);
      Object.assign(values, parsed);
      sawConfigFile = true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  const inheritedViteVariables = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('VITE_')),
  );
  assertAllowedKeys(inheritedViteVariables, 'the build environment', allowedBuildEnvironmentKeys);
  if (!sawConfigFile && Object.keys(inheritedViteVariables).length === 0) {
    throw new Error(
      'Missing production frontend configuration. Set the approved VITE_ values in frontend/.env or the deployment build environment.',
    );
  }
  Object.assign(values, inheritedViteVariables);
  assertPublicConfig(values);
}

try {
  await loadProductionConfig();
  console.log('Public frontend release configuration is complete and contains only approved VITE_ values.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
