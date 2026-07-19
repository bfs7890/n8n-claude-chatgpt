'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { query } = require('@anthropic-ai/claude-agent-sdk');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || '2mb';

// Long-running code generation can legitimately take several minutes.
// This is the ceiling for a single /claude call, not a per-turn timeout.
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 15 * 60 * 1000;
const MAX_TURNS = parseInt(process.env.MAX_TURNS, 10) || 25;

// Claude Code can read/write files and run shell commands. Point it at a
// dedicated working directory rather than the bridge's own project folder.
const CLAUDE_CWD = process.env.CLAUDE_CWD || process.cwd();

// 'default' and 'plan' will hang forever in a headless server because
// there is no terminal to answer the permission prompt. Pick a mode that
// can actually complete unattended. See README for the tradeoffs.
const PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions';

const MODEL = process.env.CLAUDE_MODEL || undefined;

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: MAX_BODY_SIZE }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.post('/claude', async (req, res) => {
  const requestId = randomUUID();
  const { prompt } = req.body || {};

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Field "prompt" is required and must be a non-empty string.',
      requestId,
    });
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let assistantText = '';
  let sawResult = false;

  try {
    const stream = query({
      prompt,
      options: {
        cwd: CLAUDE_CWD,
        permissionMode: PERMISSION_MODE,
        maxTurns: MAX_TURNS,
        abortController: controller,
        ...(MODEL ? { model: MODEL } : {}),
        // Diagnostic only: the SDK's built-in spawn path (spawnLocalProcess)
        // catches child.on('error', ...) internally and replaces it with a
        // generic message, discarding the original error object entirely.
        // This override calls the exact same child_process.spawn(...) with
        // the exact same arguments the SDK would have used itself, so
        // behavior is unchanged; the only addition is a listener that logs
        // the raw pre-wrapping error. The SDK still attaches its own
        // listeners to the returned child afterwards and behaves as normal.
        spawnClaudeCodeProcess: (spawnOptions) => {
          const { command, args, cwd, env, signal } = spawnOptions;
          const child = spawn(command, args, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            signal,
            env,
            windowsHide: true,
          });
          child.on('error', (err) => {
            console.error(`[${requestId}] RAW spawn error (pre-SDK-wrapping):`, {
              message: err.message,
              name: err.name,
              code: err.code,
              errno: err.errno,
              syscall: err.syscall,
              path: err.path,
              spawnargs: err.spawnargs,
              cause: err.cause,
              stack: err.stack,
            });
          });
          return child;
        },
      },
    });

    for await (const message of stream) {
      // Accumulate assistant text as it streams in, as a fallback in case
      // the final result message ever ships without a populated text field.
      if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            assistantText += block.text;
          }
        }
        continue;
      }

      if (message.type === 'result') {
        sawResult = true;
        clearTimeout(timeoutHandle);

        const isError = message.is_error || (message.subtype && message.subtype !== 'success');
        if (isError) {
          return res.status(502).json({
            success: false,
            error: message.error || message.result || `Claude Code ended with subtype "${message.subtype}".`,
            requestId,
          });
        }

        const output = typeof message.result === 'string' && message.result.length > 0
          ? message.result
          : assistantText;

        return res.json({ success: true, output, requestId });
      }
    }

    clearTimeout(timeoutHandle);

    if (!sawResult) {
      return res.status(502).json({
        success: false,
        error: 'Claude Code closed the stream without sending a result message.',
        requestId,
      });
    }
  } catch (err) {
    clearTimeout(timeoutHandle);

    if (controller.signal.aborted) {
      return res.status(504).json({
        success: false,
        error: `Request aborted after exceeding REQUEST_TIMEOUT_MS (${REQUEST_TIMEOUT_MS}ms).`,
        requestId,
      });
    }

    console.error(`[${requestId}] Claude query failed:`, err);

    let cause = err && err.cause;
    let causeMessage;
    if (cause) {
      causeMessage = cause.message || String(cause);
    }

    return res.status(500).json({
      success: false,
      error: err && err.message ? err.message : 'Internal server error.',
      errorName: err && err.name,
      errorCode: err && (err.code || err.errno),
      errorSyscall: err && err.syscall,
      errorCause: causeMessage,
      requestId,
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found. Use POST /claude.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`n8n-claude-bridge listening on http://${HOST}:${PORT}`);
  console.log(`  CLAUDE_CWD           = ${CLAUDE_CWD}`);
  console.log(`  CLAUDE_PERMISSION_MODE = ${PERMISSION_MODE}`);
  console.log(`  REQUEST_TIMEOUT_MS   = ${REQUEST_TIMEOUT_MS}`);
});

// Node's default 5-minute request/headers timeout would kill long code-gen
// calls mid-flight. We enforce our own ceiling via AbortController instead,
// so disable Node's socket-level timeouts here.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = REQUEST_TIMEOUT_MS + 5000;

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
