import { Command } from 'commander';
import { createMcpClient, callTool } from '../config.js';

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerAdminCommands(program: Command): void {
  const admin = program
    .command('admin')
    .description('Admin commands');

  // ── cv admin pending ─────────────────────────────────────────

  admin
    .command('pending')
    .description('List users pending approval')
    .action(async () => {
      const client = await createMcpClient();
      try {
        const result = await callTool(client, 'admin_pending') as { users: Record<string, unknown>[] };
        const users = result.users ?? [];

        if (users.length === 0) {
          console.log('No pending users.');
          return;
        }

        for (const user of users) {
          const id = String(user.id ?? '').slice(0, 8);
          console.log(`${id}  ${user.name}  type:${user.type}  created:${String(user.created_at ?? '').slice(0, 19)}`);
        }
      } finally {
        await client.close();
      }
    });

  // ── cv admin approve ─────────────────────────────────────────

  admin
    .command('approve <user_id>')
    .description('Approve a pending user')
    .action(async (userId) => {
      const client = await createMcpClient();
      try {
        await callTool(client, 'admin_approve', { user_id: userId });
        console.log(`User ${userId} approved.`);
      } finally {
        await client.close();
      }
    });
}
