import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const MCP_CONFIG_PATH = new URL('../.mcp.json', import.meta.url);
const CRAWL4AI_ARGS = ['-y', '@apify/actors-mcp-server', '--actors', 'janbuchar/crawl4ai'];

function readConfig() {
  return JSON.parse(readFileSync(MCP_CONFIG_PATH, 'utf8'));
}

function createTransport(env = {}) {
  return new StdioClientTransport({
    command: 'npx',
    args: CRAWL4AI_ARGS,
    env,
    stderr: 'pipe',
  });
}

describe('crawl4ai MCP setup', () => {
  it('.mcp.json contains crawl4ai server config', () => {
    const config = readConfig();
    assert.ok(config.mcpServers, 'mcpServers missing');
    assert.ok(config.mcpServers.crawl4ai, 'crawl4ai server config missing');
    const c4a = config.mcpServers.crawl4ai;
    assert.strictEqual(c4a.command, 'npx');
    assert.deepStrictEqual(c4a.args, CRAWL4AI_ARGS);
    assert.ok(c4a.env, 'env missing');
    assert.strictEqual(c4a.env.APIFY_TOKEN, '${APIFY_TOKEN}');
  });
});

describe('crawl4ai MCP server lifecycle', { timeout: 30000 }, () => {
  it('fails gracefully when APIFY_TOKEN is missing', async () => {
    const client = new Client({ name: 'crawl4ai-test', version: '1.0.0' });
    const transport = createTransport({});
    let stderr = '';
    transport._stderrStream?.on('data', (d) => { stderr += d; });

    try {
      await client.connect(transport);
      assert.fail('Expected connect to throw');
    } catch (err) {
      const expected =
        err.message.includes('closed') ||
        err.message.includes('EOF') ||
        err.message.includes('transport') ||
        stderr.includes('APIFY_TOKEN is required');
      assert.ok(expected, `Unexpected error: ${err.message}`);
    } finally {
      await transport.close?.().catch(() => {});
    }
  });

  it('does not immediately reject a dummy token (network/auth failure acceptable)', async () => {
    const proc = spawn('npx', CRAWL4AI_ARGS, {
      env: { ...process.env, APIFY_TOKEN: 'dummy-token-for-test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    }) + '\n');

    await new Promise((resolve) => setTimeout(resolve, 8000));
    proc.kill();
    await new Promise((resolve) => proc.on('close', resolve));

    const rejected = stderr.includes('APIFY_TOKEN is required');
    assert.ok(!rejected, 'Server should not reject a dummy token immediately; stderr: ' + stderr.slice(0, 500));
  });
});

describe('crawl4ai MCP integration (requires live APIFY_TOKEN)', { timeout: 120000 }, () => {
  it('lists tools and calls crawl4ai actor', async () => {
    if (!process.env.APIFY_TOKEN) {
      console.log('SKIP: APIFY_TOKEN not set');
      return;
    }

    const client = new Client({ name: 'crawl4ai-test', version: '1.0.0' });
    const transport = createTransport({ APIFY_TOKEN: process.env.APIFY_TOKEN });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.ok(tools.length > 0, 'Expected at least one tool');

      const crawlTool = tools.find(t => new RegExp('crawl', 'i').test(t.name));
      assert.ok(crawlTool, `Expected a crawl tool. Got: ${tools.map(t => t.name).join(', ')}`);

      const result = await client.callTool({
        name: crawlTool.name,
        arguments: {
          startUrls: [{ url: 'https://example.com' }],
          maxRequestsPerCrawl: 1,
        },
      });
      assert.ok(result.content || result.structuredContent, 'Tool result should contain content');
    } finally {
      await client.close();
      await transport.close?.().catch(() => {});
    }
  });
});
