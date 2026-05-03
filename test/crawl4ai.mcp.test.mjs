import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const MCP_CONFIG_PATH = join(ROOT, '.mcp.json');
const SERVER_COMMAND = 'npx';
const SERVER_ARGS = ['-y', '@apify/actors-mcp-server', '--actors', 'janbuchar/crawl4ai'];
const TIMEOUT_MS = 15000;

function readMcpConfig() {
  return JSON.parse(readFileSync(MCP_CONFIG_PATH, 'utf8'));
}

function createClient() {
  return new Client({ name: 'crawl4ai-test-client', version: '1.0.0' });
}

function createTransport(env = {}) {
  return new StdioClientTransport({
    command: SERVER_COMMAND,
    args: SERVER_ARGS,
    env,
    stderr: 'pipe',
  });
}

describe('crawl4ai MCP setup', () => {
  it('.mcp.json exists and contains crawl4ai server config', () => {
    const config = readMcpConfig();
    assert.ok(config.mcpServers, 'mcpServers missing');
    assert.ok(config.mcpServers.crawl4ai, 'crawl4ai server config missing');
    const c4a = config.mcpServers.crawl4ai;
    assert.strictEqual(c4a.command, 'npx');
    assert.deepStrictEqual(c4a.args, ['-y', '@apify/actors-mcp-server', '--actors', 'janbuchar/crawl4ai']);
    assert.ok(c4a.env, 'env missing');
    assert.strictEqual(c4a.env.APIFY_TOKEN, '${APIFY_TOKEN}');
  });

  it('npx binary is available', async () => {
    const proc = spawn('npx', ['--version'], { stdio: 'pipe' });
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    await new Promise((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(`npx --version exited ${code}`));
        else resolve();
      });
    });
    assert.ok(stdout.trim().length > 0, 'npx version empty');
  });
});

describe('crawl4ai MCP server lifecycle', { timeout: TIMEOUT_MS }, () => {
  it('fails to start when APIFY_TOKEN is missing', async () => {
    const client = createClient();
    const transport = createTransport({});

    let stderr = '';
    transport._stderrStream?.on('data', (d) => { stderr += d; });

    try {
      await client.connect(transport);
      assert.fail('Expected connect to throw');
    } catch (err) {
      // The server exits early; SDK may throw various errors.
      // We also collect stderr to assert the specific missing-token message.
      assert.ok(
        err.message.includes('closed') ||
        err.message.includes('EOF') ||
        err.message.includes('transport') ||
        err.message.includes('spawn') ||
        stderr.includes('APIFY_TOKEN is required'),
        `Unexpected error: ${err.message}`
      );
    } finally {
      await transport.close?.().catch(() => {});
    }
  });

  it('attempts handshake when APIFY_TOKEN is present (may fail on network)', async () => {
    // If a real token is not available, we use a dummy token.
    // The server will start, attempt to fetch actor definitions from Apify,
    // and either succeed (live token) or crash (dummy/bad token).
    // We assert that the process at least starts and the SDK handshake is attempted.
    const token = process.env.APIFY_TOKEN || 'dummy-token-for-test';
    const client = createClient();
    const transport = createTransport({ APIFY_TOKEN: token });

    let stderr = '';
    transport._stderrStream?.on('data', (d) => { stderr += d; });

    try {
      await client.connect(transport);
      // If we get here, the handshake succeeded.
      const tools = await client.listTools();
      assert.ok(Array.isArray(tools.tools), 'tools.tools should be an array');
      // Try to find a crawl-related tool
      const crawlTool = tools.tools.find(t => /crawl/i.test(t.name));
      if (crawlTool) {
        assert.ok(crawlTool.description, 'Crawl tool should have a description');
      }
      await client.close();
    } catch (err) {
      // Network or auth failure is acceptable in test environments without a real token.
      // We just want to make sure the failure mode is understood.
      const acceptable =
        err.message.includes('closed') ||
        err.message.includes('timeout') ||
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('Unauthorized') ||
        err.message.includes('401') ||
        err.message.includes('ApifyClient') ||
        stderr.includes('API request failed');

      if (!acceptable) {
        throw new Error(`Unexpected failure during handshake: ${err.message}\nSTDERR: ${stderr}`);
      }

      // If we land here due to network/auth, that's acceptable in CI/test without real credentials.
      assert.ok(true, `Handshake attempted but failed due to environment (acceptable): ${err.message}`);
    } finally {
      await transport.close?.().catch(() => {});
    }
  });
});

describe('crawl4ai MCP integration (requires live APIFY_TOKEN)', { timeout: 60000 }, () => {
  it('lists tools and calls crawl4ai actor', async () => {
    if (!process.env.APIFY_TOKEN) {
      console.log('SKIP: APIFY_TOKEN not set');
      return;
    }

    const client = createClient();
    const transport = createTransport({ APIFY_TOKEN: process.env.APIFY_TOKEN });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.ok(tools.length > 0, 'Expected at least one tool from crawl4ai actor');

      const crawlTool = tools.find(t => /crawl/i.test(t.name));
      if (!crawlTool) {
        console.log('Available tools:', tools.map(t => t.name).join(', '));
      }
      assert.ok(crawlTool, 'Expected a tool with "crawl" in its name');

      // Attempt a lightweight crawl (example.com).
      // Schema may vary, so we wrap in try/catch for informative failure.
      try {
        const result = await client.callTool({
          name: crawlTool.name,
          arguments: {
            startUrls: [{ url: 'https://example.com' }],
            maxRequestsPerCrawl: 1,
          },
        });
        assert.ok(result.content || result.structuredContent, 'Tool result should contain content');
      } catch (toolErr) {
        // If arguments schema mismatches, report but do not hard-fail the test setup.
        assert.fail(`Tool call failed: ${toolErr.message}`);
      }
    } finally {
      await client.close();
      await transport.close?.().catch(() => {});
    }
  });
});
