import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const env = { ...process.env };
for (const line of readFileSync(join(repoRoot, '.env'), 'utf8').split('\n')) {
  const t = line.trim();
  if (t === '' || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i > 0) env[t.slice(0, i)] = t.slice(i + 1).replace(/^["']|["']$/g, '');
}
env.AQAR_MCP_MODE = 'propose';

const command = join(here, '..', 'node_modules', '.bin', 'tsx');
const args = [join(here, '..', 'src', 'stdio.ts')];
console.log('command', command);
console.log('spawn at', new Date().toISOString());

const transport = new StdioClientTransport({ command, args, env, stderr: 'pipe' });
transport.onerror = (error) => console.log('TRANSPORT_ERROR', error.message);
transport.onclose = () => console.log('TRANSPORT_CLOSED');

const client = new Client({ name: 'aqar-smoke', version: '0.0.0' }, { capabilities: {} });

const withTimeout = (label, promise, ms = 20000) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT:${label}`)), ms)),
  ]);

try {
  await withTimeout('connect', client.connect(transport));
  console.log('CONNECTED', new Date().toISOString());
  const { tools } = await withTimeout('listTools', client.listTools());
  console.log('TOOLS', tools.length, tools.map((t) => t.name).join(','));
} catch (error) {
  console.log('FAILED', error.message);
  try {
    console.log(
      'STDERR:',
      transport.stderr ? await transport.stderr.read()?.toString() : '(no stream)',
    );
  } catch (readError) {
    console.log('stderr read failed', readError.message);
  }
} finally {
  await client.close().catch(() => {});
}
process.exit(0);
