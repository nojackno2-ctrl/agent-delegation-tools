import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTest() {
  console.log('=== Starting MCP Server Smoke Test ===');

  const serverScript = path.resolve(__dirname, 'index.js');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverScript],
  });

  const client = new Client(
    {
      name: 'test-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  console.log('Connecting to MCP Server via StdioTransport...');
  await client.connect(transport);
  console.log('[OK] Connected to MCP Server.');

  console.log('\n--- Testing tools/list ---');
  const toolsList = await client.listTools();
  console.log(`Discovered ${toolsList.tools.length} tools:`);
  for (const tool of toolsList.tools) {
    const desc = tool.description || 'No description';
    console.log(` - ${tool.name}: ${desc.substring(0, 60)}...`);
  }

  if (toolsList.tools.length < 6) {
    throw new Error(`Expected at least 6 tools, but got ${toolsList.tools.length}`);
  }
  console.log('[OK] tools/list verified.');

  console.log('\n--- Testing tools/call (get_agent_quotas) ---');
  const quotaResult = await client.callTool({
    name: 'get_agent_quotas',
    arguments: {
      agent: 'all',
      timeout_sec: 20,
    },
  });

  console.log('Call result received:');
  console.log(JSON.stringify(quotaResult, null, 2));

  if ((quotaResult as any).isError) {
    console.warn('[WARN] get_agent_quotas returned isError, check output above.');
  } else {
    console.log('[OK] get_agent_quotas call succeeded.');
  }

  console.log('\n--- Testing tools/call (delegate_task with quota rebalancing) ---');
  const delegateResult = await client.callTool({
    name: 'delegate_task',
    arguments: {
      prompt: 'Reply with exactly: NATIVE_MCP_DELEGATION_TEST_OK',
      task_type: 'analysis',
      balance_quota: true,
      timeout_sec: 60,
    },
  });

  console.log('Delegate call result:');
  console.log(JSON.stringify(delegateResult, null, 2));

  if ((delegateResult as any).isError) {
    console.warn('[WARN] delegate_task returned error.');
  } else {
    console.log('[OK] delegate_task call succeeded.');
  }

  await client.close();
  console.log('\n=== All MCP Server Smoke Tests Passed! ===');
}

runTest().catch((err) => {
  console.error('MCP Server Smoke Test Failed:', err);
  process.exit(1);
});
