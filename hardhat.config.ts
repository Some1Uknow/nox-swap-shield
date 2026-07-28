import 'dotenv/config';
import hardhatNodeTestRunner from '@nomicfoundation/hardhat-node-test-runner';
import hardhatViemPlugin from '@nomicfoundation/hardhat-viem';
import { defineConfig } from 'hardhat/config';
import type { HardhatUserConfig } from 'hardhat/types/config';
import noxPlugin from '@iexec-nox/nox-hardhat-plugin';

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || '';
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || '';

const networks: NonNullable<HardhatUserConfig['networks']> = {
  default: {
    type: 'edr-simulated',
    chainType: 'op',
    allowUnlimitedContractSize: true,
  },
};

if (SEPOLIA_RPC_URL) {
  networks.sepolia = {
    type: 'http',
    chainType: 'l1',
    url: SEPOLIA_RPC_URL,
    // An empty account list fails closed when credentials are missing rather
    // than silently deploying from a publicly known fallback key.
    accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    chainId: 11155111,
  };
}

export default defineConfig({
  // Keep the minimal Viem integration rather than the whole toolbox: Nox uses
  // `connection.viem`, while the toolbox unnecessarily pulls deployment and
  // verification packages that this project does not use.
  plugins: [hardhatViemPlugin, hardhatNodeTestRunner, noxPlugin],
  // Nox Protocol Contracts v0.2.4 require Solidity >=0.8.35.
  solidity: '0.8.35',
  networks,
  // Recheck the Nox supported-networks page before deployment; its chain
  // configuration can change independently of this pinned package set.
  nox: {
    // Set to true if you want `hardhat test` to skip booting the offchain
    // Docker stack (e.g. to run non-Nox unit tests without Docker installed).
    skipTestOverride: false,
  },
});
