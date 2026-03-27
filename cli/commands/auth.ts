import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import {
  ensureCvDir,
  loadConfig,
  saveConfig,
  loadToken,
  saveToken,
  loadPublicKey,
  loadPrivateKey,
  quickCall,
  KEY_PATH,
  PUBKEY_PATH,
  CV_DIR,
} from '../config.js';

// ---------------------------------------------------------------------------
// Helper: sign nonce with ed25519 private key
// ---------------------------------------------------------------------------

function signNonce(privateKeyPem: string, nonce: string): string {
  const keyObject = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(nonce, 'utf8'), keyObject);
  return signature.toString('base64');
}

// ---------------------------------------------------------------------------
// Helper: convert ed25519 public key to SSH format
// ---------------------------------------------------------------------------

function publicKeyToSSH(publicKeyPem: string): string {
  const keyObject = crypto.createPublicKey(publicKeyPem);
  const der = keyObject.export({ type: 'spki', format: 'der' });
  // DER for ed25519 spki: 12 bytes prefix + 32 bytes raw key
  const rawKey = der.subarray(12);

  // SSH wire format: uint32 len + "ssh-ed25519" + uint32 len + raw key
  const typeStr = 'ssh-ed25519';
  const typeLen = Buffer.alloc(4);
  typeLen.writeUInt32BE(typeStr.length);
  const keyLen = Buffer.alloc(4);
  keyLen.writeUInt32BE(rawKey.length);
  const blob = Buffer.concat([typeLen, Buffer.from(typeStr), keyLen, rawKey]);
  return `ssh-ed25519 ${blob.toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerAuthCommands(program: Command): void {
  // ── cv init ──────────────────────────────────────────────────

  program
    .command('init')
    .description('Generate ed25519 keypair at ~/.cv/')
    .action(async () => {
      await ensureCvDir();

      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const sshPubKey = publicKeyToSSH(publicKey);

      await writeFile(KEY_PATH, privateKey, { mode: 0o600 });
      await writeFile(PUBKEY_PATH, sshPubKey + '\n', { mode: 0o644 });

      console.log(`Keypair generated:`);
      console.log(`  Private: ${KEY_PATH}`);
      console.log(`  Public:  ${PUBKEY_PATH}`);
      console.log();
      console.log(`Public key:`);
      console.log(`  ${sshPubKey}`);
    });

  // ── cv register ──────────────────────────────────────────────

  program
    .command('register')
    .description('Register as a new user')
    .requiredOption('--name <name>', 'Display name')
    .action(async (opts) => {
      const publicKey = await loadPublicKey();

      const result = await quickCall('register_user', {
        name: opts.name,
        type: 'human',
        public_key: publicKey,
      }, { noAuth: true }) as { id: string; status: string };

      const config = await loadConfig();
      config.user_id = result.id;
      await saveConfig(config);

      console.log(`Registered as: ${opts.name}`);
      console.log(`  User ID: ${result.id}`);
      console.log(`  Status:  ${result.status}`);
      console.log();
      console.log(`User ID saved to ~/.cv/config`);

      if (result.status === 'pending') {
        console.log(`\nYour account is pending admin approval.`);
      }
    });

  // ── cv auth ──────────────────────────────────────────────────

  const auth = program
    .command('auth')
    .description('Authentication commands');

  // ── cv auth login ────────────────────────────────────────────

  auth
    .command('login')
    .description('Authenticate via challenge/response')
    .action(async () => {
      const config = await loadConfig();
      if (!config.user_id) {
        console.error('Error: No user_id in config. Run "cv register" first.');
        process.exit(1);
      }

      const privateKeyPem = await loadPrivateKey();

      // Step 1: Request challenge
      const challenge = await quickCall('authenticate', {
        user_id: config.user_id,
        action: 'request_challenge',
      }, { noAuth: true }) as { nonce: string; expires_at: string };

      // Step 2: Sign the nonce
      const signature = signNonce(privateKeyPem, challenge.nonce);

      // Step 3: Verify signature and get token
      const verified = await quickCall('authenticate', {
        user_id: config.user_id,
        action: 'verify',
        nonce: challenge.nonce,
        signature,
      }, { noAuth: true }) as { token: string };

      await saveToken(verified.token);

      console.log(`Authenticated successfully.`);
      console.log(`Token saved to ~/.cv/token`);
    });

  // ── cv auth status ───────────────────────────────────────────

  auth
    .command('status')
    .description('Show current auth status')
    .action(async () => {
      const config = await loadConfig();
      const token = await loadToken();

      console.log(`Config directory: ${CV_DIR}`);
      console.log(`User ID: ${config.user_id ?? '(not set)'}`);
      console.log(`Server URL: ${config.server_url ?? '(default: stdio)'}`);
      console.log(`Token: ${token ? 'present' : '(none)'}`);

      if (token) {
        // Decode JWT payload without verification (just for display)
        try {
          const parts = token.split('.');
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
          console.log();
          console.log(`Token claims:`);
          console.log(`  sub:  ${payload.sub}`);
          console.log(`  name: ${payload.name}`);
          console.log(`  type: ${payload.type}`);
          if (payload.exp) {
            const expDate = new Date(payload.exp * 1000);
            const now = new Date();
            const expired = expDate < now;
            console.log(`  exp:  ${expDate.toISOString()}${expired ? ' (EXPIRED)' : ''}`);
          }
        } catch {
          console.log(`  (could not decode token)`);
        }
      }
    });

  // ── cv agent create ──────────────────────────────────────────

  const agent = program
    .command('agent')
    .description('Agent management commands');

  agent
    .command('create')
    .description('Create an agent under current user')
    .requiredOption('--name <name>', 'Agent name')
    .action(async (opts) => {
      const config = await loadConfig();
      if (!config.user_id) {
        console.error('Error: No user_id in config. Run "cv register" first.');
        process.exit(1);
      }

      const token = await loadToken();
      if (!token) {
        console.error('Error: Not authenticated. Run "cv auth login" first.');
        process.exit(1);
      }

      // Generate a new keypair for the agent
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const sshPubKey = publicKeyToSSH(publicKey);

      // Register agent
      const result = await quickCall('register_user', {
        name: opts.name,
        type: 'agent',
        public_key: sshPubKey,
        parent_id: config.user_id,
      }, { noAuth: true }) as { id: string; status: string };

      // Authenticate agent to get its token
      const challenge = await quickCall('authenticate', {
        user_id: result.id,
        action: 'request_challenge',
      }, { noAuth: true }) as { nonce: string };

      const signature = signNonce(privateKey, challenge.nonce);

      const verified = await quickCall('authenticate', {
        user_id: result.id,
        action: 'verify',
        nonce: challenge.nonce,
        signature,
      }, { noAuth: true }) as { token: string };

      console.log(`Agent created:`);
      console.log(`  Name:    ${opts.name}`);
      console.log(`  ID:      ${result.id}`);
      console.log(`  Status:  ${result.status}`);
      console.log();
      console.log(`Agent token (use in CV_TOKEN env var):`);
      console.log(`  ${verified.token}`);
    });

  // ── cv mcp-config ────────────────────────────────────────────

  program
    .command('mcp-config')
    .description('Print MCP config JSON snippet for use in agent config files')
    .action(async () => {
      const token = await loadToken();

      const config = {
        mcpServers: {
          clairvoyant: {
            command: 'npx',
            args: ['tsx', 'src/server.ts'],
            env: {
              CV_TOKEN: token ?? '<your-token-here>',
            },
          },
        },
      };

      console.log(JSON.stringify(config, null, 2));
    });
}
