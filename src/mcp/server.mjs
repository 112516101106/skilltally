import { homedir } from 'node:os';
import { getHomeDir, loadConfig } from '../core/config.mjs';
import { readAllEvents } from '../core/store.mjs';
import { scanInventory } from '../inventory/scan.mjs';
import { aggregateStats } from '../report/aggregate.mjs';
import { buildChains } from '../report/chains.mjs';
import { buildTimeline } from '../report/timeline.mjs';

const MCP_TOOLS = [
  {
    name: 'skilltally_stats',
    description:
      'Get skill activation and read statistics (including 14d sparklines, trigger ratios, and context ROI) across Antigravity, Claude Code, Codex, and Gemini CLI.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Time window: e.g. 7d, 30d, 90d, 2026-01-01, or all (default: 30d)' },
        host: { type: 'string', description: 'Optional host filter: antigravity, claude, codex, gemini, or all' },
        project: { type: 'string', description: 'Optional project basename filter' },
        bySource: { type: 'boolean', description: 'Separate duplicate skill names by source' },
        metric: { type: 'string', enum: ['activations', 'reads'], description: 'Sort metric (default: activations)' },
        limit: { type: 'number', description: 'Optional max number of skill rows to return' },
      },
    },
  },
  {
    name: 'skilltally_unused',
    description:
      'List enabled installed skills with zero activations in the window and compute Context Tax (KB and ~tokens/session) grouped by source.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Time window (default: 90d)' },
        host: { type: 'string', description: 'Optional host filter' },
      },
    },
  },
  {
    name: 'skilltally_timeline',
    description: 'Aggregate skill activations and reads over time buckets (day, week, or month).',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Optional skill name filter' },
        by: { type: 'string', enum: ['day', 'week', 'month'], description: 'Bucket granularity (default: day)' },
        since: { type: 'string', description: 'Time window (default: 30d)' },
        host: { type: 'string', description: 'Optional host filter' },
        project: { type: 'string', description: 'Optional project basename filter' },
      },
    },
  },
  {
    name: 'skilltally_chains',
    description:
      'Analyze multi-skill session workflows: ordered transitions (A -> B), 3-step sequences, and co-occurring skill pairs with Jaccard similarity.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Time window (default: 30d)' },
        host: { type: 'string', description: 'Optional host filter' },
        project: { type: 'string', description: 'Optional project basename filter' },
        limit: { type: 'number', description: 'Max entries per section (default: 20)' },
      },
    },
  },
  {
    name: 'skilltally_insights',
    description:
      'Return actionable optimization insights: Context Tax ROI, manual-only skills needing better SKILL.md descriptions, single-project scoping candidates, and model breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Time window (default: 30d)' },
        host: { type: 'string', description: 'Optional host filter' },
        project: { type: 'string', description: 'Optional project basename filter' },
      },
    },
  },
];

function toolError(id, message) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      isError: true,
      content: [{ type: 'text', text: String(message) }],
    },
  };
}

function toolOk(id, payload) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    },
  };
}

export function handleMcpRequest(
  msg,
  { dataHome = getHomeDir(), pkgVersion = '1.1.0', homeDir = homedir(), cwd = process.cwd() } = {}
) {
  if (!msg || typeof msg !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }

  const method = msg.method;
  const hasId = msg.id !== undefined && msg.id !== null;

  if (typeof method === 'string' && method.startsWith('notifications/')) {
    return null;
  }
  if (!hasId) {
    return null;
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'skilltally', version: pkgVersion },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id: msg.id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: MCP_TOOLS },
    };
  }

  if (method === 'tools/call') {
    const toolName = msg.params?.name;
    const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};

    try {
      const { events, corruptLines } = readAllEvents(dataHome);
      const config = loadConfig(dataHome);
      const inventory = scanInventory({ homeDir, cwd, includeProject: true });

      if (toolName === 'skilltally_stats') {
        const report = aggregateStats({
          events,
          inventory,
          config,
          since: args.since ?? '30d',
          host: args.host || null,
          project: args.project || null,
          bySource: Boolean(args.bySource),
          metric: args.metric === 'reads' ? 'reads' : 'activations',
        });
        const limit = args.limit !== undefined ? Number(args.limit) : null;
        if (limit !== null && (!Number.isFinite(limit) || limit < 1)) {
          return toolError(msg.id, `Invalid limit: "${args.limit}"`);
        }
        const rows = limit ? report.rows.slice(0, limit) : report.rows;
        return toolOk(msg.id, { ...report, rows, corruptLines });
      }

      if (toolName === 'skilltally_unused') {
        const report = aggregateStats({
          events,
          inventory,
          config,
          since: args.since ?? '90d',
          host: args.host || null,
        });
        return toolOk(msg.id, {
          window: report.window,
          inventory: report.inventory,
          unused: report.unused,
        });
      }

      if (toolName === 'skilltally_timeline') {
        const timeline = buildTimeline({
          events,
          inventory,
          config,
          skill: args.skill || null,
          by: args.by ?? 'day',
          since: args.since ?? '30d',
          host: args.host || null,
          project: args.project || null,
        });
        return toolOk(msg.id, timeline);
      }

      if (toolName === 'skilltally_chains') {
        const limit = args.limit !== undefined ? Number(args.limit) : 20;
        if (!Number.isFinite(limit) || limit < 1) {
          return toolError(msg.id, `Invalid limit: "${args.limit}"`);
        }
        const chains = buildChains({
          events,
          inventory,
          config,
          since: args.since ?? '30d',
          host: args.host || null,
          project: args.project || null,
          limit,
        });
        return toolOk(msg.id, chains);
      }

      if (toolName === 'skilltally_insights') {
        const report = aggregateStats({
          events,
          inventory,
          config,
          since: args.since ?? '30d',
          host: args.host || null,
          project: args.project || null,
        });
        return toolOk(msg.id, {
          window: report.window,
          totals: report.totals,
          inventory: report.inventory,
          insights: report.insights,
        });
      }

      return toolError(msg.id, `Unknown tool: "${toolName}"`);
    } catch (err) {
      return toolError(msg.id, err?.message || 'Tool execution failed');
    }
  }

  return {
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

function sendMcpMessage(output, obj, framed) {
  const json = JSON.stringify(obj);
  if (framed) {
    const bytes = Buffer.byteLength(json, 'utf8');
    output.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
  } else {
    output.write(`${json}\n`);
  }
}

export function startMcpServer({
  dataHome = getHomeDir(),
  pkgVersion = '1.1.0',
  homeDir = homedir(),
  cwd = process.cwd(),
  input = process.stdin,
  output = process.stdout,
} = {}) {
  let buf = Buffer.alloc(0);

  const dispatchRaw = (rawJson, framed) => {
    const trimmed = rawJson.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      sendMcpMessage(
        output,
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        framed
      );
      return;
    }
    const res = handleMcpRequest(parsed, { dataHome, pkgVersion, homeDir, cwd });
    if (res !== null) {
      sendMcpMessage(output, res, framed);
    }
  };

  const drainBuffer = () => {
    while (buf.length > 0) {
      // Trim leading CR/LF before inspecting framing
      let start = 0;
      while (start < buf.length && (buf[start] === 0x0d || buf[start] === 0x0a)) {
        start += 1;
      }
      if (start > 0) buf = buf.subarray(start);
      if (buf.length === 0) break;

      const prefix = buf.subarray(0, Math.min(32, buf.length)).toString('ascii');
      if (/^content-length:/i.test(prefix)) {
        let sepIdx = buf.indexOf('\r\n\r\n');
        let sepLen = 4;
        if (sepIdx === -1) {
          sepIdx = buf.indexOf('\n\n');
          sepLen = 2;
        }
        if (sepIdx === -1) break;

        const header = buf.subarray(0, sepIdx).toString('ascii');
        const m = header.match(/content-length:\s*(\d+)/i);
        if (!m) {
          buf = buf.subarray(sepIdx + sepLen);
          continue;
        }
        const len = Number(m[1]);
        const bodyStart = sepIdx + sepLen;
        if (buf.length < bodyStart + len) break;

        const body = buf.subarray(bodyStart, bodyStart + len).toString('utf8');
        buf = buf.subarray(bodyStart + len);
        dispatchRaw(body, true);
      } else {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) break;
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 1);
        dispatchRaw(line, false);
      }
    }
  };

  input.on('data', (chunk) => {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buf = Buffer.concat([buf, b]);
    drainBuffer();
  });

  input.on('end', () => {
    drainBuffer();
    const rest = buf.toString('utf8').trim();
    if (rest && !/^content-length:/i.test(rest)) {
      dispatchRaw(rest, false);
      buf = Buffer.alloc(0);
    }
  });
}
